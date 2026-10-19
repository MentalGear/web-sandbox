/**
 * The lifecycle of `<web-sandbox>` as one pure reducer (backlog S65 step 2; research 18, class L, design 3), and the
 * executor that applies its effects. Internal: src/index.ts does not export it.
 *
 * PR A of S65 step 2 wrote this module to describe exactly what src/host.ts did, and the later PRs move host.ts onto it
 * one path at a time (B: the terminations; C: the builds and the DOM callbacks; D: the completion of a build and the
 * `ready` gate). It is checked against the lifecycle reference model (test/model/lifecycle-model.ts) by
 * test/model/reducer-runner.ts, which runs `reduce` and `runEffects` against a fake host on thousands of generated
 * sequences (test/unit/lifecycle-reducer.test.ts), and on each class-L finding's trace.
 *
 * host.ts keeps the lifecycle state in this module's `LcState` (the element's `_lc`) and steps its inputs through this
 * executor (host.ts, the module-level `step`). Since PR B: every termination, terminate() and the element's own, each
 * with the generation it was armed in (`terminate{gen}`). Since PR C: every build (connect, reset(), load(),
 * setConfig(): `connect`, `build`, `setConfig`, `configured`, and the build effect's `built` and `buildFailed`), the
 * element's removal and adoption (`disconnect`), the files (`filesChanged`) and the load deadline (`loadDeadline`).
 * Until PR D, the completion of a build and `ready` stay host.ts's (`_completeBuild`, `_finishBuild`, `_enterReady`,
 * which writes `state: 'ready'` itself).
 *
 * Class L's invariant (research 18): each transition is reachable by one path, guarded by one predicate; events are
 * dispatched only after the state has settled, never from inside the embedder's own call; queued work is released only
 * at the gate it waits for; an actor of an old environment cannot act. What carries each part here:
 * - one path, one predicate: every transition is a case of `reduce`, and nothing else computes a next state;
 * - the state settles first: `step` stores the reducer's state before the executor runs a single effect, and in every
 *   output the resource effects come before the dispatches (a listener finds the environment it is told about in place);
 * - one gate: `flush` is emitted by one function (`enterReady`), always together with `dispatch ready`, and `ready` is
 *   reached only from `loading` (review round 5, L-1: strict mode flushed at the wrapper's load);
 * - an old environment cannot act: every input a platform callback, a timer or the build effect delivers carries the
 *   generation it was armed in, and `reduce` drops a stale one with no effect at all (review B4's rule, by construction
 *   rather than by port identity and stopped timers); and the executor runs an output's effects only while the
 *   environment it was computed for stands, so it stops at the first effect after embedder code tore that environment
 *   down (review B5 and round 4's L-2: `_notifyThenAct`'s rule, at one comparison site; LM-2: embedder code that runs
 *   inside the element's own build, or inside its warning, and builds again).
 *
 * Where src/host.ts and the S65 plan disagree, this module follows host.ts (and README.md and docs/API.md), and says so
 * at the place: search for "Today's code".
 */
import type { SandboxState } from '../host';

// The reasons the lifecycle itself decides. src/host.ts keeps its own copies (SECOND_LOAD_REASON and the others) until
// PR D moves the completion of a build here; test/unit/lifecycle-reducer.test.ts checks that the two agree.
export const LIFECYCLE_REASONS = Object.freeze({
    secondLoad: 'the sandbox frame loaded a second time',
    secondAnnouncement: 'the guest frame announced itself again (it reloaded or rewrote its document)',
    frameMissing: 'the guest frame is missing',
    loadTimeout: 'the sandbox did not finish loading',
    startupBlocked: "the sandbox's startup script did not run: the host page's Content-Security-Policy must allow it (see docs/API.md#host-page-policy)",
});

/**
 * What a build reads besides the reducer's own state, asked of the host at the moment the build starts: whether the
 * element may build where it is (host.ts, buildsHere: in the defining realm's document, and connected; review round 2,
 * L-1), the refusal the config and the files give apart from an unusable config (an unknown mode, review A4; a strict
 * entry that names no registered JavaScript file, review round 2, L-4), and the two facts of the build that its
 * completion depends on: strict mode (the view checks in on its port, VIEW_READY) and whether the guest frame runs a
 * bootstrap that announces its port (`allow-scripts` in cooperative mode, always in worker mode; CB1).
 */
export interface BuildContext {
    buildsHere: boolean;
    blocked: string | null;
    strict: boolean;
    announces: boolean;
}

/** A line the element dispatches as 'sandbox-log' before it acts (host.ts, `_notifyThenAct`): one event per notice. */
export interface Notice {
    level: 'error' | 'warn';
    text: string;
    source: 'host' | 'guest'; // 'guest': the guest's own text, through the guest relay's rate limit (F3)
}

/**
 * The progress of the standing build, from the build effect to the next teardown (host.ts: `_frameLoaded`,
 * `_expectAnnouncement`, the announcement listener's `accepted`, `_guestWindow`).
 */
export interface BuildProgress {
    readonly strict: boolean;
    readonly announces: boolean;
    readonly frameLoaded: boolean; // the wrapper's one load arrived
    readonly accepted: boolean; // the one announcement this build accepts arrived (a port, or worker mode's refusal)
    readonly checkedIn: boolean; // it carried a port: the guest frame it came from is the one the wrapper's load must hold (S46)
}

export interface LcState {
    readonly state: SandboxState;
    // Counts environments: every teardown increments it (host.ts, `_generation`). The only clock the reducer compares.
    readonly gen: number;
    // A build's 'terminated' waiting for its task (round 1's R3-2), with the generation it belongs to. host.ts holds a
    // token object instead; the two are the same rule, since every teardown both clears the token and increments the
    // generation, and nothing else replaces the token.
    readonly pending: { readonly reason: string; readonly gen: number } | null;
    // The 'terminated' reasons being dispatched, innermost last (host.ts, `_terminationDispatched`, saved and restored
    // around each dispatch: the same stack, kept as one value and the call stack).
    readonly dispatching: readonly string[];
    // The 'terminated' being dispatched when the last build started, or null (round 2's L-4; host.ts's `_buildWithin`
    // until S65's PR B). Kept across teardowns: only the next build replaces it.
    readonly within: string | null;
    readonly build: BuildProgress | null;
    // What a build reads changed this many times: setConfig(), load(), the files (host.ts's `_buildInputs` until PR C).
    readonly inputs: number;
    // `inputs` when the last usable setConfig() argument was stored, or null after a refusal (the copy itself is the
    // host's data, host.ts's `_lastConfig`, compared by the host: `setConfig.same`).
    readonly lastInputs: number | null;
    // Why the last setConfig() argument could not be used, or null (host.ts's `_configRefusal` until PR C): every build
    // is refused with it while it is set.
    readonly refused: string | null;
}

export const INITIAL_LIFECYCLE: LcState = Object.freeze({
    state: 'idle',
    gen: 0,
    pending: null,
    dispatching: Object.freeze([]) as readonly string[],
    within: null,
    build: null,
    inputs: 0,
    lastInputs: null,
    refused: null,
});

/**
 * What can happen to the lifecycle. The inputs that carry `gen` come from a platform callback or a timer armed in that
 * environment, and are dropped when it is gone; the others come from the embedder's call or from the executor itself,
 * now, and carry none.
 */
export type LcInput =
    // connectedCallback (host.ts, `connected`); the host does not step it when the engine refused to give a Firefox-adopted
    // element its prototype back (restorePrototype: the element stays idle, as its `disconnect` left it).
    | { t: 'connect'; ctx: BuildContext }
    // disconnectedCallback and adoptedCallback alike (host.ts, `disconnected`, `adopted`): the environment ends, quietly.
    | { t: 'disconnect' }
    // reset() and load() (load() stores its html first: the host's data).
    | { t: 'build'; why: 'reset' | 'load'; ctx: BuildContext }
    // setConfig(): `same` is the host's comparison of the structured clone with the last usable copy (a clone that failed
    // is never the same). The rest of the no-op predicate is the reducer's (R3-7).
    | { t: 'setConfig'; same: boolean }
    // The config was applied (the `applyConfig` effect): its refusal, or null, and the context of the build it starts.
    | { t: 'configured'; refusal: string | null; ctx: BuildContext }
    // registerFiles(), unregisterFiles() or commitGuestWrites() changed the store (its 'fileschanged' is the host's).
    | { t: 'filesChanged' }
    // The build effect returned what it prepared, or threw (the reason the host gives for what it threw), for the build of
    // `gen` (LM-2: embedder code can run inside the build effect and build again, and then this build is gone). The
    // `attach` effect's own throw is a `buildFailed` of its build too.
    | { t: 'built'; gen: number; prepared: unknown }
    | { t: 'buildFailed'; gen: number; reason: string }
    // The task of a build's 'terminated' (R3-2).
    | { t: 'buildTerminationDue'; gen: number }
    // A termination. Without `gen`: terminate() (its reason already defaulted, review round 2, L-7), or a build failure
    // the executor caught. With `gen`: one the element starts (the watchdog, the view's watchdog, workerExecutionTimeout,
    // the uncaught budget, VIEW_OVERRUN, an entry failure, a host-page refusal, a second announcement, the frame-integrity
    // checks at the wrapper's load), whatever decides it (the host decides, for instance, which VIEW_OVERRUN ends the
    // sandbox); with `notices`, the lines dispatched before it, one by one.
    | { t: 'terminate'; reason: string; gen?: number; notices?: readonly Notice[] }
    // The load deadline (CB3): LOAD_TIMEOUT_MS of loading. `wrapperLoaded`: whether the wrapper's one load arrived, as
    // host.ts reports it until PR D steps that load here (`frameLoad`, which records it in the build's progress); left
    // out, the build's progress says.
    | { t: 'loadDeadline'; gen: number; wrapperLoaded?: boolean }
    // The wrapper's load, in the microtask the host's load handler queues (review round 4, L-1): `gen` as the load event
    // found it; `stillOurs` whether, in the microtask, the frame is still the element's and both are connected; `guest`
    // the guest frame's window: none, the one whose announcement was accepted, or another (round 2's L-6, S46).
    | { t: 'frameLoad'; gen: number; stillOurs: boolean; guest: 'none' | 'announcer' | 'other' }
    // The guest frame's announcement (CB1). `valid`: trusted, and exactly one port or worker mode's refusal; `refusal`:
    // the reason worker mode's frame gave for a worker that could not start (review round 2, C-5), else null.
    | { t: 'announced'; gen: number; valid: boolean; refusal: string | null; port: unknown }
    // The strict view's check-in on its port (R3-1), with what the host checks then.
    | { t: 'viewReady'; gen: number; height: unknown; stillStyleRefused: boolean }
    // Around each 'terminated' dispatch (the executor's; round 4's L-3: every one, so the no-repeat rule holds for all).
    | { t: 'dispatchStarted'; reason: string }
    | { t: 'dispatchEnded' };

export type Effect =
    | { k: 'teardown' } // host.ts, `_teardown` without its generation and pending-termination lines, which are the reducer's
    | { k: 'discardWrites' }
    | { k: 'applyConfig' } // stores the clone (normaliseConfig), and answers with its refusal: then `configured`
    // host.ts, `_prepareBuild`: everything of the build that can run embedder code (the HTML sinks a host page's Trusted
    // Types default policy runs at, the warnings), into values the element does not hold yet; then `built`, or
    // `buildFailed` if it threw
    | { k: 'build' }
    // host.ts, `_attachBuild`: the prepared build becomes the element's (its frame, its announcement listener, its bridge
    // and overlay); no embedder code runs there, so no other build can come in between (LM-2)
    | { k: 'attach'; prepared: unknown }
    | { k: 'startLoadDeadline' }
    | { k: 'stopLoadDeadline' }
    | { k: 'sendInitView' } // strict mode, at the wrapper's load: the view gets its ports (`_setupStrictChannels`)
    | { k: 'openChannel'; port: unknown } // cooperative and worker mode: the announced port, or none (`setupChannel`)
    | { k: 'closePort'; port: unknown }
    | { k: 'checkView'; height: unknown; stillStyleRefused: boolean } // the view's size and still-style warnings (R3-1)
    | { k: 'flush' } // what waited for `ready` goes to the port (`_flushQueues`)
    | { k: 'startWatchdogs' } // the guest's and, in strict mode, the view's
    | { k: 'startAutoResize' }
    | { k: 'warn'; text: string } // a console warning
    | { k: 'warnForeignDocument' } // once per element (CB7)
    | { k: 'dispatch'; event: 'ready' }
    | { k: 'dispatch'; event: 'terminated'; reason: string }
    | { k: 'notice'; notice: Notice }
    | { k: 'step'; input: LcInput } // a nested step, synchronously
    | { k: 'task'; input: LcInput }; // a step in a task of its own

export interface LcOutput {
    state: LcState;
    effects: readonly Effect[];
    // Whether an effect that throws ends the sandbox (`BUILD_FAILED_REASON`): host.ts runs the completion of a build at
    // the wrapper's load (`_onFrameLoad`) and at the guest's check-in (`_finishBuild`) in a try/catch. Today's code does
    // not at the view's check-in: `_onViewMessage` calls `_enterReady()` bare, so a throw there leaves the build
    // `loading`, its load deadline already stopped. These effects do not throw in practice (they are backstops), so the
    // difference is not observable; it is kept as it is, and listed in the PR for PR D to decide.
    guarded?: boolean;
}

// ---- the reducer -------------------------------------------------------------------------------------------------

const NOTHING: readonly Effect[] = Object.freeze([]);

const unchanged = (state: LcState): LcOutput => ({ state, effects: NOTHING });

const top = (stack: readonly string[]): string | null => (stack.length > 0 ? stack[stack.length - 1]! : null);

// The generation-and-pending half of host.ts's `_teardown`: a new environment count, and a build's 'terminated' still
// to come is no longer the sandbox's state (R3-2). The resource half is the `teardown` effect.
function tornDown(state: LcState): LcState {
    return { ...state, gen: state.gen + 1, pending: null, build: null };
}

// host.ts, `_terminate`: every termination that is not a build's. Already terminated means nothing to do, which is what
// makes 'terminated' fire once per termination. Warned first, then torn down, then dispatched synchronously: terminate()
// keeps its documented synchronous event (docs/API.md, Lifecycle), and a listener reads `state` 'terminated'.
function terminateNow(state: LcState, reason: string): LcOutput {
    if (state.state === 'terminated') return unchanged(state);
    return {
        state: { ...tornDown(state), state: 'terminated' },
        effects: [{ k: 'warn', text: `[Sandbox] terminated: ${reason}` }, { k: 'teardown' }, { k: 'dispatch', event: 'terminated', reason }],
    };
}

// host.ts, `_terminateBuild`: the termination of the build being made. The state is 'terminated' at once; the event comes
// in a task of its own, like 'ready' (round 1's R3-2), so a listener added right after setConfig(), reset() or load()
// hears it; and not at all if the environment changed meanwhile (`buildTerminationDue` is dropped as stale).
// The one "no repeat" rule (CB5; round 2's L-4; round 3's L-1; round 4's L-3): a build started while a 'terminated' is
// dispatched, refused or failed with that very reason, ends 'terminated' and dispatches nothing, and says nothing either
// (the answer being dispatched was warned already). Without it a 'terminated' listener that built again from the same
// inputs recursed until the stack ran out (CB5); with it every such build ends at once, so no listener can loop. The rule
// is on the answer, never a build skipped (round 3's L-1: a listener's move left the element connected and 'idle').
// The second teardown is what host.ts did before the reducer drove its builds (it tore down in initialize() and again
// in _terminateBuild), kept: a refused build counts the generation up twice (`initialize`, then here); the reference
// model counts once, and the oracle compares only whether it changed.
function terminateBuild(state: LcState, reason: string): LcOutput {
    if (state.state === 'terminated') return unchanged(state);
    const repeated = state.within === reason;
    const next = { ...tornDown(state), state: 'terminated' as const };
    const effects: Effect[] = [];
    if (!repeated) effects.push({ k: 'warn', text: `[Sandbox] terminated: ${reason}` });
    effects.push({ k: 'teardown' });
    if (repeated) return { state: next, effects };
    effects.push({ k: 'task', input: { t: 'buildTerminationDue', gen: next.gen } });
    return { state: { ...next, pending: { reason, gen: next.gen } }, effects };
}

// The element left (or never reached) a document it can build in (host.ts's `stop` until PR C). No event.
function stop(state: LcState): LcOutput {
    return { state: { ...tornDown(state), state: 'idle' }, effects: [{ k: 'teardown' }, { k: 'discardWrites' }] };
}

// The one place a build starts (connection, reset(), load(), setConfig(); host.ts's `initialize` until PR C), then the
// build effect, whose answer is `built` or `buildFailed` (LM-2: see there). Every build runs, from a
// 'terminated' listener too (round 3's L-1); the no-repeat rule is on its answer (terminateBuild). Where the element may
// not build (round 2's L-1: one predicate, asked by every build), it stops instead and stays idle. Otherwise 'loading'
// first: every attempt that fails is one termination with its own reason, also from 'terminated' (reset() of a refused
// config says again why it cannot start).
function initialize(state: LcState, ctx: BuildContext): LcOutput {
    const within = top(state.dispatching);
    const torn: LcState = { ...tornDown(state), within };
    const effects: Effect[] = [{ k: 'teardown' }, { k: 'discardWrites' }];
    if (!ctx.buildsHere) return { state: { ...torn, state: 'idle' }, effects };
    const refusal = state.refused ?? ctx.blocked;
    if (refusal !== null) {
        const refused = terminateBuild({ ...torn, state: 'loading' }, refusal);
        return { state: refused.state, effects: [...effects, ...refused.effects] };
    }
    const build: BuildProgress = { strict: ctx.strict, announces: ctx.announces, frameLoaded: false, accepted: false, checkedIn: false };
    effects.push({ k: 'build' });
    return { state: { ...torn, state: 'loading', build }, effects };
}

// host.ts, `_enterReady`: the transition to `ready`, in every mode, and the one place what waited for it is released
// (review round 5, L-1). The load deadline stops; the queue goes to the port in the order it was issued; the watchdogs
// are armed before 'ready' is dispatched (a 'ready' listener that resets or terminates stops them with the rest, instead
// of leaving one running for a port that is gone); the resizer is in place for the reports buffered before the port.
// Today's code sets `state` last, just before the dispatch; here it is 'ready' before the first effect, as every state
// is. Nothing the flush or the watchdogs run reads it (the host's own code, no embedder code), so the difference is not
// observable; test/unit/lifecycle-reducer.test.ts pins the order for PR D.
function enterReady(state: LcState, before: readonly Effect[] = NOTHING): LcOutput {
    return {
        state: { ...state, state: 'ready' },
        effects: [...before, { k: 'stopLoadDeadline' }, { k: 'flush' }, { k: 'startWatchdogs' }, { k: 'startAutoResize' }, { k: 'dispatch', event: 'ready' }],
        guarded: true,
    };
}

// host.ts, `_finishBuild`: cooperative and worker mode complete at the guest's check-in, with its port, or, where the
// guest runs no bootstrap, at the wrapper's load, with none. Not loading any more: the port is closed, nothing else.
function finishBuild(state: LcState, port: unknown): LcOutput {
    if (state.state !== 'loading') return { state, effects: port === null ? NOTHING : [{ k: 'closePort', port }] };
    return enterReady(state, [{ k: 'openChannel', port }]);
}

// host.ts, `_frameLoadHandler` (its microtask) then `_completeBuild`. The wrapper is written once and has no script, so it
// loads exactly once: a second load means something navigated or reloaded it. A guest that checked in already must be
// the one the load holds (S46). Then: a bootstrap's check-in completes the build, after this load; strict mode hands the
// view its ports and completes at VIEW_READY, never on this load alone (R3-1: it also fires for a view whose bootstrap
// the host page refused); a guest with no bootstrap completes now.
function frameLoad(state: LcState, input: Extract<LcInput, { t: 'frameLoad' }>): LcOutput {
    const build = state.build;
    if (!input.stillOurs || build === null) return unchanged(state);
    const guarded = (output: LcOutput): LcOutput => ({ ...output, guarded: true });
    if (build.frameLoaded) return guarded(terminateNow(state, LIFECYCLE_REASONS.secondLoad));
    const loaded: LcState = { ...state, build: { ...build, frameLoaded: true } };
    if (build.checkedIn) return guarded(input.guest === 'announcer' ? unchanged(loaded) : terminateNow(loaded, LIFECYCLE_REASONS.secondLoad));
    if (input.guest === 'none') return guarded(terminateNow(loaded, LIFECYCLE_REASONS.frameMissing));
    if (build.announces) return guarded(unchanged(loaded));
    if (build.strict) return { state: loaded, effects: [{ k: 'sendInitView' }], guarded: true };
    return finishBuild(loaded, null);
}

// host.ts, `_listenForAnnouncement`: exactly one announcement per environment, from a build that expects one. Any other
// (a second one, one strict mode's frame never sends, an untrusted or malformed one) ends the environment: a guest that
// reloads or rewrites itself announces again, and a forgery can only end its own environment (PD8). Worker mode's
// refusal is the frame's one announcement: one host line, then the termination with its reason (review round 2, C-5).
function announced(state: LcState, input: Extract<LcInput, { t: 'announced' }>): LcOutput {
    const build = state.build;
    if (build === null || build.accepted || !build.announces || !input.valid) return terminateNow(state, LIFECYCLE_REASONS.secondAnnouncement);
    if (input.refusal !== null) {
        const accepted: LcState = { ...state, build: { ...build, accepted: true } };
        return refusedByHostPage(accepted, input.refusal);
    }
    const checkedIn: LcState = { ...state, build: { ...build, accepted: true, checkedIn: true } };
    return { ...finishBuild(checkedIn, input.port), guarded: true };
}

// host.ts, `_refusedByHostPage`: one host line, then the termination, unless a listener of that line acted first.
function refusedByHostPage(state: LcState, reason: string): LcOutput {
    return terminate(state, { t: 'terminate', reason, gen: state.gen, notices: [{ level: 'error', text: `[Sandbox] ${reason}`, source: 'host' }] });
}

// host.ts, `_notifyThenAct` and `_terminate`. With notices, the lines come first, one event each, and the termination is a
// nested step after them: the executor stops before the next notice, and before the step, once a listener tore the
// environment down (review B5; round 4's L-2: a second line of one callback reached the next environment's listeners).
function terminate(state: LcState, input: Extract<LcInput, { t: 'terminate' }>): LcOutput {
    const notices = input.notices ?? [];
    if (notices.length === 0) return terminateNow(state, input.reason);
    const effects: Effect[] = [];
    for (const notice of notices) effects.push({ k: 'notice', notice });
    effects.push({ k: 'step', input: { t: 'terminate', reason: input.reason, gen: state.gen } });
    return { state, effects };
}

// Why a build is still `loading` at its deadline (host.ts's `_loadTimeoutReason` until PR C): once the wrapper has
// loaded, the frame that runs the library's startup script (the strict view, or the guest's bootstrap) has loaded too,
// and that script runs first: had it run, it would have checked in. So the host page's policy stopped it (R3-1). Before
// the wrapper's load, the frame did not finish loading. A deadline
// bounds `loading` only, of the build it was started for (LM-2): the input carries that build's generation, and it acts
// only while that build is `loading`; `_enterReady` stops it as well, but the bound does not rest on a timer stopped.
function loadDeadline(state: LcState, input: Extract<LcInput, { t: 'loadDeadline' }>): LcOutput {
    const build = state.build;
    if (state.state !== 'loading' || build === null) return unchanged(state);
    const scripted = build.strict || build.announces;
    const loaded = input.wrapperLoaded ?? build.frameLoaded;
    return terminateNow(state, loaded && scripted ? LIFECYCLE_REASONS.startupBlocked : LIFECYCLE_REASONS.loadTimeout);
}

// host.ts, `_dispatchBuildTermination`: only if nothing tore the environment down since it was armed.
function buildTerminationDue(state: LcState): LcOutput {
    const pending = state.pending;
    if (pending === null || pending.gen !== state.gen || state.state !== 'terminated') return unchanged(state);
    return { state: { ...state, pending: null }, effects: [{ k: 'dispatch', event: 'terminated', reason: pending.reason }] };
}

// setConfig() (host.ts's `_isCurrentConfig` until PR C; review round 1, R3-7): the configuration the standing
// environment was built from, again, with nothing a build reads changed since and no refusal standing, rebuilds nothing
// (an embedder that applies its config on every edit keeps its guest). Otherwise the inputs count up, and the host
// applies the copy: the no-op is decided before anything of the argument is applied (warnings, the stored config).
function setConfig(state: LcState, same: boolean): LcOutput {
    const current = same && state.lastInputs === state.inputs && state.refused === null && (state.state === 'ready' || state.state === 'loading');
    if (current) return unchanged(state);
    return { state: { ...state, inputs: state.inputs + 1 }, effects: [{ k: 'applyConfig' }] };
}

function configured(state: LcState, input: Extract<LcInput, { t: 'configured' }>): LcOutput {
    const stored: LcState = { ...state, refused: input.refusal, lastInputs: input.refusal === null ? state.inputs : null };
    return initialize(stored, input.ctx);
}

// The inputs that carry the generation they were armed in: dropped, with no effect and no change, once it is gone.
const STAMPED = new Set<LcInput['t']>(['built', 'buildFailed', 'buildTerminationDue', 'loadDeadline', 'frameLoad', 'announced', 'viewReady']);

/** Whether `input` belongs to an environment that is gone: then `reduce` gives no effects and leaves the state as it is. */
export function isStale(state: LcState, input: LcInput): boolean {
    if (input.t === 'terminate') return input.gen !== undefined && input.gen !== state.gen;
    return STAMPED.has(input.t) && (input as { gen: number }).gen !== state.gen;
}

/** The lifecycle's one transition function: pure, total, and the only place a next state is computed. */
export function reduce(state: LcState, input: LcInput): LcOutput {
    if (isStale(state, input)) return unchanged(state);
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
            // LM-2 (class L; S65 step 2, PR C). Embedder code runs inside the build effect: a host page's Trusted Types
            // default policy at each HTML sink it writes (the wrapper's srcdoc, the inert parse of the markup), a patched
            // console.warn at each warning. One that called reset() there built again, from inside the build: the nested
            // build stood, and the outer one then went on over it with the element's fields. It started a second load
            // deadline and overwrote the first, which was never stopped and ended the sandbox LOAD_TIMEOUT_MS later,
            // `ready` as it was; it put its announcement listener on the nested frame and overwrote the nested one's stop,
            // so one listener outlived its environment; it appended the nested frame a second time; and its failure, had
            // it thrown, ended the nested build. Fixed by construction, in three parts:
            // - the build effect prepares and attaches nothing (host.ts, `_prepareBuild`), and this input carries the
            //   generation of its build: a build that a nested one replaced is stale here, and what it prepared is
            //   dropped, never the element's;
            // - the build becomes the element's in `attach`, which runs no embedder code, and every per-build resource is
            //   made there or later and released by the `teardown` effect: one frame, one listener, one deadline per build;
            // - the deadline starts here, once per build (one `built` per build effect), and acts only for its generation
            //   and only while that build is `loading` (`loadDeadline`).
            return state.state === 'loading' ? { state, effects: [{ k: 'attach', prepared: input.prepared }, { k: 'startLoadDeadline' }] } : unchanged(state);
        case 'buildFailed':
            // A build's failure carries the generation of its build (S65 PR C; it carried none before, as `_terminateBuild`
            // was guarded by the state only). It is that build's answer: a refusal known before building is decided inside
            // `initialize` and needs no input, so this input comes only from the build effect (or `attach`), and the only
            // way its build can be gone by then is embedder code inside the build that built again (LM-2). That nested
            // build then stands, complete, and the outer build's failure is no longer the sandbox's state, exactly as a
            // build's deferred 'terminated' is not once another build started (`buildTerminationDue`, R3-2). Without the
            // generation, the outer build's throw ended a build that had nothing wrong with it.
            return terminateBuild(state, input.reason);
        case 'buildTerminationDue':
            return buildTerminationDue(state);
        case 'terminate':
            return terminate(state, input);
        case 'loadDeadline':
            return loadDeadline(state, input);
        case 'frameLoad':
            return frameLoad(state, input);
        case 'announced':
            return announced(state, input);
        case 'viewReady':
            // host.ts, `_onViewMessage` VIEW_READY: the view's check-in, the first frame on the port only its bootstrap
            // holds (R3-1). Not guarded (see LcOutput.guarded).
            if (state.state !== 'loading') return unchanged(state);
            return { ...enterReady(state, [{ k: 'checkView', height: input.height, stillStyleRefused: input.stillStyleRefused }]), guarded: false };
        case 'dispatchStarted':
            return { state: { ...state, dispatching: [...state.dispatching, input.reason] }, effects: NOTHING };
        case 'dispatchEnded':
            return { state: { ...state, dispatching: state.dispatching.slice(0, -1) }, effects: NOTHING };
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
    sendInitView(): void;
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

// The executor's one comparison of generations (review B5; round 4's L-2; LM-2): whether the environment an output, or a
// host path's announcement, was made for was torn down since, by embedder code that ran in between (a listener of what
// was just dispatched, a Trusted Types default policy inside the build, a patched console.warn). `reduce` drops a stale
// input (isStale); this stops what is left of a run once its environment is gone. host.ts compares generations
// nowhere else, apart from a call's own environment (`_issue`, `_postRpc`; review round 3, L-2), and
// test/unit/lifecycle-reducer.test.ts scans for it.
const tornDownSince = (host: { readonly lc: LcState }, stampGen: number): boolean => host.lc.gen !== stampGen;

/**
 * Applies one output's effects in order. `stampGen` is the generation the output was computed at: before each effect the
 * executor compares it with the state's, and stops once embedder code tore the environment down in between, so nothing
 * of the output acts on the environment that replaced it (review B5; round 4's L-2: that comparison is `_notifyThenAct`'s,
 * here at one site). Until S65's PR C it was made before a dispatch, a notice or a nested step only, since only those run
 * embedder code; but a resource effect can too (a warning, through a patched console.warn), and a `teardown` after a
 * warning whose hook built again tore down that new build, leaving it `loading` with no frame. Now no effect of a gone
 * environment runs. With `guarded`, an effect other than a dispatch that throws ends the sandbox, as today's try/catch at
 * the completion of a build does (`_onFrameLoad`, `_finishBuild`).
 */
export function runEffects(host: LifecycleHost, effects: readonly Effect[], stampGen: number, guarded = false): void {
    for (const effect of effects) {
        if (tornDownSince(host, stampGen)) return;
        if (!guarded || isEmbedderFacing(effect)) {
            runEffect(host, effect, stampGen);
            continue;
        }
        try {
            runEffect(host, effect, stampGen);
        } catch (error) {
            host.step({ t: 'terminate', reason: host.failureReason(error, 'complete') });
            return;
        }
    }
}

/**
 * The same rule for a host path that is not a transition of the lifecycle (host.ts, `_handleGuestWrite`: 'fileswritten',
 * then the guest's acknowledgement): each notice dispatches one event, the next one runs only if no listener tore the
 * environment down meanwhile, and `act` runs only then too (review B5: an action after a listener's reset() or
 * terminate() would undo it). This was host.ts's `_notifyThenAct`; its terminations are `terminate{gen, notices}` now.
 * True if `act` ran.
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

function runEffect(host: LifecycleHost, effect: Effect, stampGen: number): void {
    switch (effect.k) {
        case 'teardown': host.teardown(); return;
        case 'discardWrites': host.discardWrites(); return;
        case 'applyConfig': {
            // Not compared with `stampGen`: today's setConfig() applies and builds with nothing in between.
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
        case 'sendInitView': host.sendInitView(); return;
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
    }
}

// The build effect: anything the build throws ends it with a reason (follow-up audit 2026-10-14), and a build that
// returned is attached and starts its deadline. Both answers carry the generation of the build (`stampGen`, the one its
// output was computed at), and `reduce` drops them once embedder code inside the build built again (LM-2: see `built`
// and `buildFailed` in reduce).
function runBuild(host: LifecycleHost, stampGen: number): void {
    let prepared: unknown;
    try {
        prepared = host.build();
    } catch (error) {
        host.step({ t: 'buildFailed', gen: stampGen, reason: host.failureReason(error, 'build') });
        return;
    }
    host.step({ t: 'built', gen: stampGen, prepared });
}

// host.ts, `_dispatchTerminated`: the one place 'terminated' is dispatched (round 4's L-3), with its reason on the
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
