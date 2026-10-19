// @vitest-environment node
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { INITIAL_LIFECYCLE, admits, isStale, reduce, runEffects, step, type BuildContext, type Effect, type Generation, type LcInput, type LcOutput, type LcState, type LifecycleHost, type Notice } from '../../src/lib/lifecycle';
import { reasonText, TERMINATION_REASONS } from '../../src/lib/reasons';
import { generate, shrink } from '../model/generator';
import { DEFAULT_TERMINATE_REASON, ENTRY_FAILED_REASON, unknownModeReason, type Sequence } from '../model/lifecycle-model';
import { forTheReducer, runReducerSequence, validConfig, type ReducerRunOptions } from '../model/reducer-runner';

/**
 * The lifecycle reducer (src/lib/lifecycle.ts; S65 step 2, PR A), checked three ways:
 * - against the lifecycle reference model (test/model/lifecycle-model.ts) on thousands of generated sequences, through
 *   test/model/reducer-runner.ts, which runs the real `reduce` and `runEffects` against a fake element; a divergence is
 *   shrunk (test/model/generator.ts, `shrink`) and printed with its seed, the minimal sequence and its trace;
 * - by the reducer's own properties, on every step of those runs and on inputs fuzzed from the states they reached;
 * - on each class-L finding as an explicit trace (research 18, class L): round 4's L-1, L-2 and L-3, round 5's L-1, CB5
 *   (broad review 2026-10-14) and round 1's R3-2.
 * And it pins the places where the reducer describes today's host.ts rather than the S65 plan.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const RUNS = Number(process.env.WEB_SANDBOX_REDUCER_RUNS ?? 5000);
const FIRST_SEED = Number(process.env.WEB_SANDBOX_REDUCER_SEED ?? 1);

// ---- the reducer's properties, for one step --------------------------------------------------------------------------

const RESOURCE_EFFECTS = new Set<Effect['k']>(['teardown', 'discardWrites', 'applyConfig', 'build', 'startLoadDeadline', 'stopLoadDeadline', 'sendInitView', 'openChannel', 'closePort', 'checkView', 'flush', 'startWatchdogs', 'startAutoResize']);
const isDispatch = (effect: Effect) => effect.k === 'dispatch' || effect.k === 'notice';
const isReady = (effect: Effect) => effect.k === 'dispatch' && effect.event === 'ready';

/** What a step's output may not do; null when it keeps every property. */
function brokenProperty(before: LcState, input: LcInput, output: LcOutput): string | null {
    const effects = output.effects;
    const kinds = effects.map(effect => effect.k).join(',');
    // a stale generation gives no effects, and changes nothing
    if (isStale(before, input) && (effects.length > 0 || output.state !== before)) return `a stale ${input.t} gave [${kinds}]`;
    // connect and disconnect never dispatch, notify or step synchronously: a failure comes in a task
    if ((input.t === 'connect' || input.t === 'disconnect') && effects.some(effect => isDispatch(effect) || effect.k === 'step')) return `${input.t} gave [${kinds}]`;
    // `flush` exactly together with `dispatch ready`, and `ready` only from loading, into ready
    const flushes = effects.filter(effect => effect.k === 'flush').length;
    const readies = effects.filter(isReady).length;
    if (flushes !== readies || flushes > 1) return `${input.t} gave ${flushes} flush and ${readies} ready: [${kinds}]`;
    if (readies === 1 && (before.state !== 'loading' || output.state.state !== 'ready')) return `ready from ${before.state} into ${output.state.state}`;
    if (output.state.state === 'ready' && before.state !== 'ready' && readies === 0) return `${input.t} entered ready without dispatching it`;
    // dispatches come last: no resource effect after a dispatch or a notice
    const first = effects.findIndex(isDispatch);
    if (first >= 0 && effects.slice(first).some(effect => RESOURCE_EFFECTS.has(effect.k))) return `a resource effect after a dispatch: [${kinds}]`;
    // a 'terminated' dispatch leaves the state 'terminated'
    if (effects.some(effect => effect.k === 'dispatch' && effect.event === 'terminated') && output.state.state !== 'terminated') return `terminated dispatched into ${output.state.state}`;
    return null;
}

// ---- the oracle run ------------------------------------------------------------------------------------------------

function failsFor(options: ReducerRunOptions = {}) {
    return async (candidate: Sequence) => !runReducerSequence(forTheReducer(candidate), options).ok;
}

async function report(seed: number, divergence: string) {
    const minimal = await shrink(forTheReducer(generate(seed)), failsFor(), 200);
    const again = runReducerSequence(minimal);
    return `seed ${seed}: ${divergence}\nminimal (${minimal.cmds.length} commands): ${JSON.stringify(minimal)}\n${again.trace.join('\n')}`;
}

const sampled = new Map<string, LcState>(); // distinct states the runs reached, for the fuzzed inputs below

describe('the reducer against the lifecycle model', () => {
    it(`${RUNS} generated sequences, without calls, execute(), commits or listings, agree with the model, and every step keeps the reducer's properties`, async () => {
        const started = performance.now();
        const totals: Record<string, number> = {};
        const coverage = new Set<string>();
        let steps = 0;
        let broken: string | null = null;
        const onStep = (before: LcState, input: LcInput, output: LcOutput) => {
            steps++;
            if (broken === null) broken = brokenProperty(before, input, output);
            if (steps % 11 === 0 && JSON.stringify(reduce(before, input)) !== JSON.stringify(output)) broken = `reduce is not pure on ${input.t}`;
            if (sampled.size < 400 && steps % 5 === 0) sampled.set(JSON.stringify(before), before);
        };
        for (let seed = FIRST_SEED; seed < FIRST_SEED + RUNS; seed++) {
            const result = runReducerSequence(forTheReducer(generate(seed)), { onStep });
            for (const [key, value] of Object.entries(result.stats)) totals[key] = (totals[key] ?? 0) + value;
            for (const key of result.coverage) coverage.add(key);
            if (broken !== null) expect.fail(`seed ${seed}: a reducer property broke: ${broken}`);
            if (!result.ok) expect.fail(await report(seed, result.divergence!));
        }
        const ms = Math.round(performance.now() - started);
        console.log(`MEASURED reducer oracle: ${RUNS} sequences, ${steps} steps, ${ms} ms; ${JSON.stringify(totals)}`);
        // what the runs must have reached for the agreement to mean something
        for (const input of ['connect', 'disconnect', 'build', 'setConfig', 'configured', 'filesChanged', 'built', 'buildTerminationDue', 'terminate', 'loadDeadline', 'frameLoad', 'announced', 'viewReady', 'dispatchStarted', 'dispatchEnded'] as const) {
            expect(totals[`input:${input}`] ?? 0, input).toBeGreaterThan(0);
        }
        for (const stale of ['frameLoad', 'announced', 'viewReady', 'loadDeadline', 'buildTerminationDue']) expect(totals[`stale:${stale}`] ?? 0, `stale ${stale}`).toBeGreaterThan(0);
        for (const key of ['event:terminated-refusal', 'event:terminated-self', 'event:ready']) {
            for (const mode of ['strict', 'cooperative', 'worker']) expect(coverage.has(`${key}|${mode}`), `${key}|${mode}`).toBe(true);
        }
    }, 120_000);
});

describe("the reducer's properties on fuzzed inputs", () => {
    const contexts: BuildContext[] = [
        { buildsHere: true, blocked: null, strict: true, announces: false },
        { buildsHere: true, blocked: null, strict: false, announces: true },
        { buildsHere: true, blocked: null, strict: false, announces: false },
        { buildsHere: true, blocked: 'unknown mode "Strict"', strict: false, announces: false },
        { buildsHere: false, blocked: null, strict: true, announces: false },
    ];
    function inputsFor(state: LcState): LcInput[] {
        // the current generation, and two that are not: made here only, as no code of the library's makes one
        const gens = [state.gen, (state.gen - 1) as Generation, (state.gen + 1) as Generation];
        const inputs: LcInput[] = [{ t: 'disconnect' }, { t: 'filesChanged' }, { t: 'setConfig', same: true }, { t: 'setConfig', same: false }, { t: 'terminate', reason: 'bye' }, { t: 'dispatchStarted', reason: 'bye' }];
        if (state.dispatching.length > 0) inputs.push({ t: 'dispatchEnded' });
        for (const ctx of contexts) inputs.push({ t: 'connect', ctx }, { t: 'build', why: 'reset', ctx }, { t: 'build', why: 'load', ctx }, { t: 'configured', refusal: null, ctx }, { t: 'configured', refusal: 'refused', ctx });
        for (const gen of gens) {
            inputs.push({ t: 'buildTerminationDue', gen }, { t: 'loadDeadline', gen }, { t: 'viewReady', gen, height: 100, stillStyleRefused: false });
            inputs.push({ t: 'built', gen, prepared: {} }, { t: 'buildFailed', gen, reason: 'x' });
            inputs.push({ t: 'terminate', reason: 'self', gen }, { t: 'terminate', reason: 'self', gen, notices: [{ level: 'error', text: 'line', source: 'host' }] });
            for (const guest of [null, ANNOUNCER, OTHER]) for (const stillOurs of [true, false]) inputs.push({ t: 'frameLoad', gen, stillOurs, guest });
            for (const valid of [true, false]) for (const refusal of [null, 'refused']) inputs.push({ t: 'announced', gen, valid, refusal, port: {}, source: ANNOUNCER });
        }
        return inputs;
    }

    it('every input on every sampled state: stale gens give nothing, connect and disconnect never dispatch, flush only with ready, dispatches last; one the declaration does not admit throws', () => {
        // the states the oracle reached (the test above), and the same ones with a 'terminated' being dispatched
        const states = sampled.size > 0 ? [...sampled.values()] : [INITIAL_LIFECYCLE];
        let checked = 0;
        let refused = 0;
        for (const base of states) {
            for (const state of [base, { ...base, dispatching: [...base.dispatching, 'bye'] }]) {
                for (const input of inputsFor(state)) {
                    if (!isStale(state, input) && !admits(state, input)) {
                        expect(() => reduce(state, input), `${input.t} in ${state.state}`).toThrow(/cannot arrive in/);
                        refused++;
                        continue;
                    }
                    const output = reduce(state, input);
                    checked++;
                    const broken = brokenProperty(state, input, output);
                    if (broken) expect.fail(`${broken}\nstate ${JSON.stringify(state)}\ninput ${JSON.stringify(input)}`);
                }
            }
        }
        expect(checked).toBeGreaterThan(10_000);
        expect(refused).toBeGreaterThan(1000);
    });

    it('connect, with a build that throws: no synchronous dispatch; the termination comes in a task', () => {
        const host = new RecordingHost();
        host.buildThrows = true;
        host.step({ t: 'connect', ctx: COOPERATIVE });
        expect(host.lc.state).toBe('terminated');
        expect(host.events).toEqual([]);
        expect(host.tasks).toEqual([{ t: 'buildTerminationDue', gen: host.lc.gen }]);
        host.runTasks();
        expect(host.events).toEqual(['terminated failed (build)']);
    });
});

// ---- a host that records what the executor asks of it ---------------------------------------------------------------

const COOPERATIVE: BuildContext = { buildsHere: true, blocked: null, strict: false, announces: true };
const NO_BOOTSTRAP: BuildContext = { buildsHere: true, blocked: null, strict: false, announces: false };
const STRICT: BuildContext = { buildsHere: true, blocked: null, strict: true, announces: false };
// Guest frame windows, as identities (frameLoad.guest, announced.source): the one that checked in, and another one.
const ANNOUNCER = Object.freeze({ window: 'announcer' });
const OTHER = Object.freeze({ window: 'other' });

class RecordingHost implements LifecycleHost {
    lc: LcState = INITIAL_LIFECYCLE;
    log: string[] = [];
    events: string[] = [];
    tasks: LcInput[] = [];
    ctx: BuildContext = COOPERATIVE;
    refusal: string | null = null;
    buildThrows = false;
    onBuild: (() => void) | null = null;
    onEvent: ((event: string) => void) | null = null;
    step(input: LcInput) { step(this, input); }
    task(input: LcInput) { this.tasks.push(input); }
    runTasks() {
        while (this.tasks.length > 0) this.step(this.tasks.shift()!);
    }
    teardown() { this.log.push('teardown'); }
    discardWrites() { this.log.push('discardWrites'); }
    applyConfig() { this.log.push('applyConfig'); return this.refusal; }
    buildContext() { return this.ctx; }
    build() {
        this.log.push('build');
        const prepared = { build: this.log.filter(line => line === 'build').length }; // which build, counted from 1
        const reenter = this.onBuild;
        this.onBuild = null;
        reenter?.();
        if (this.buildThrows) throw new Error('the build throws');
        return prepared;
    }
    attach(prepared: unknown) { this.log.push(`attach ${JSON.stringify(prepared)}`); }
    failureReason(_error: unknown, phase: string) { return `failed (${phase})`; }
    startLoadDeadline() { this.log.push('startLoadDeadline'); }
    stopLoadDeadline() { this.log.push('stopLoadDeadline'); }
    sendInitView() { this.log.push('sendInitView'); }
    openChannel() { this.log.push('openChannel'); }
    closePort() { this.log.push('closePort'); }
    checkView() { this.log.push('checkView'); }
    flush() { this.log.push('flush'); }
    startWatchdogs() { this.log.push('startWatchdogs'); }
    startAutoResize() { this.log.push('startAutoResize'); }
    warn(text: string) { this.log.push(`warn ${text}`); }
    warnForeignDocument() { this.log.push('warnForeignDocument'); }
    private event(event: string) {
        this.log.push(`dispatch ${event}`);
        this.events.push(event);
        this.onEvent?.(event);
    }
    dispatchReady() { this.event('ready'); }
    dispatchTerminated(reason: string) { this.event(`terminated ${reason}`); }
    notice(notice: Notice) { this.event(`notice ${notice.text}`); }
}

// A standing cooperative environment: connected, announced, ready.
function readyHost(): RecordingHost {
    const host = new RecordingHost();
    host.step({ t: 'connect', ctx: COOPERATIVE });
    host.step({ t: 'announced', gen: host.lc.gen, valid: true, refusal: null, port: {}, source: ANNOUNCER });
    expect(host.lc.state).toBe('ready');
    host.log = [];
    host.events = [];
    return host;
}

const sequence = (mode: Sequence['mode'], cmds: Sequence['cmds'], plans: Sequence['plans'] = []): Sequence => ({ seed: 7, mode, plans, cmds });
const PROLOGUE: Sequence['cmds'] = [{ op: 'register', files: { 'agent.js': 'AGENT', 'bad.js': 'BAD', 'data.txt': 'data' } }];

describe('class L, finding by finding', () => {
    describe("round 4, L-1: `ready` from inside the embedder's appendChild() or remove()", () => {
        // A cooperative build without a bootstrap completes at the wrapper's load. The element is moved while it loads, and
        // the frame fires its load inside the move, before the element's lifecycle reactions (Chromium, WebKit).
        const moved = sequence('cooperative', [...PROLOGUE, { op: 'setConfig', cfg: validConfig('cooperative', { noScripts: true, html: 'plain' }) }, { op: 'insert' }, { op: 'insert' }, { op: 'settle' }]);
        it('before the fix: a load handled in the load event completes the build inside the move', () => {
            const result = runReducerSequence(moved, { syncFrameLoad: true, silentGuests: 0 });
            expect(result.divergence).toMatch(/ready dispatched (inside a DOM operation|synchronously)/);
        });
        it('after it: the load counts in a microtask, after the move; its generation is gone, and the moved build is `ready` from a task', () => {
            const result = runReducerSequence(moved, { silentGuests: 0 });
            expect(result.ok, result.divergence).toBe(true);
            expect(result.stats['stale:frameLoad']).toBeGreaterThanOrEqual(1);
            expect(result.stats['event:ready']).toBe(1);
        });
        it('the reducer alone does not prevent it: a current-generation load would complete the build; the microtask in the adapter is what keeps it out of the DOM call', () => {
            const host = new RecordingHost();
            host.step({ t: 'connect', ctx: NO_BOOTSTRAP });
            const output = reduce(host.lc, { t: 'frameLoad', gen: host.lc.gen, stillOurs: true, guest: OTHER });
            expect(output.effects.some(isReady)).toBe(true);
            expect(reduce(host.lc, { t: 'frameLoad', gen: host.lc.gen, stillOurs: false, guest: OTHER }).effects).toEqual([]);
        });
    });

    describe("round 4, L-2: two notices of one callback, the second after a listener's teardown", () => {
        const notices: Notice[] = [{ level: 'error', text: `[Sandbox] ${ENTRY_FAILED_REASON}`, source: 'host' }, { level: 'error', text: 'the guest says why', source: 'guest' }];
        it('the notices come first, one effect each, and the termination is a nested step after them', () => {
            const host = readyHost();
            const output = reduce(host.lc, { t: 'terminate', reason: ENTRY_FAILED_REASON, gen: host.lc.gen, notices });
            expect(output.effects.map(effect => effect.k)).toEqual(['notice', 'notice', 'step']);
            expect(output.state).toBe(host.lc);
        });
        it('before the fix: without a stop between notices, the guest line reaches the next environment and the termination ends it', () => {
            const host = readyHost();
            host.onEvent = (event) => { if (event.startsWith('notice [Sandbox]')) host.step({ t: 'build', why: 'reset', ctx: COOPERATIVE }); };
            const output = reduce(host.lc, { t: 'terminate', reason: ENTRY_FAILED_REASON, gen: host.lc.gen, notices });
            for (const effect of output.effects) { // the effects run as one list, as `_notifyThenAct` did before round 4
                if (effect.k === 'notice') host.notice(effect.notice);
                if (effect.k === 'step') host.step({ ...effect.input, gen: host.lc.gen } as LcInput);
            }
            expect(host.events).toEqual([`notice [Sandbox] ${ENTRY_FAILED_REASON}`, 'notice the guest says why', `terminated ${ENTRY_FAILED_REASON}`]);
        });
        it("after it: the executor stops at the listener's teardown; the new build stands, nothing more is dispatched", () => {
            const host = readyHost();
            host.onEvent = (event) => { if (event.startsWith('notice [Sandbox]')) host.step({ t: 'build', why: 'reset', ctx: COOPERATIVE }); };
            host.step({ t: 'terminate', reason: ENTRY_FAILED_REASON, gen: host.lc.gen, notices });
            expect(host.events).toEqual([`notice [Sandbox] ${ENTRY_FAILED_REASON}`]);
            expect(host.lc.state).toBe('loading');
        });
    });

    describe("round 4, L-3: the no-repeat rule holds for every `terminated`, not only a build's", () => {
        const reason = unknownModeReason('Strict');
        const terminated = (terminateWith: string) => sequence('strict', [...PROLOGUE, { op: 'setConfig', cfg: validConfig('strict') }, { op: 'insert' }, { op: 'settle' }, { op: 'terminate', reason: terminateWith }, { op: 'settle' }], [
            { event: 'terminated', action: { op: 'setConfig', cfg: { kind: 'unknownMode', mode: 'Strict' } }, times: 1 },
        ]);
        it('terminate(reason) whose listener sets a config refused with that very reason: one `terminated`, no second one in a task', () => {
            const result = runReducerSequence(terminated(reason), { silentGuests: 0 });
            expect(result.ok, result.divergence).toBe(true);
            expect(result.stats['event:terminated']).toBe(1);
            expect(result.stats['input:buildTerminationDue'] ?? 0).toBe(0);
        });
        it('a refusal with another reason is dispatched, in a task of its own', () => {
            const result = runReducerSequence(terminated('bye'), { silentGuests: 0 });
            expect(result.ok, result.divergence).toBe(true);
            expect(result.stats['event:terminated']).toBe(2);
            expect(result.stats['input:buildTerminationDue']).toBe(1);
        });
        it('the rule is on the answer, for terminate() as for a build: `within` is the innermost reason being dispatched', () => {
            const host = readyHost();
            host.onEvent = (event) => { if (event === `terminated ${reason}`) host.step({ t: 'build', why: 'reset', ctx: { ...STRICT, blocked: reason } }); };
            host.step({ t: 'terminate', reason });
            expect(host.lc.within).toBe(reason);
            expect(host.lc.state).toBe('terminated');
            expect(host.tasks).toEqual([]);
            expect(host.lc.dispatching).toEqual([]);
        });
    });

    describe('round 5, L-1: queued work leaves only at `ready`, in every mode', () => {
        it("strict mode: the wrapper's load sends the view its ports and flushes nothing; the view's check-in flushes, with `ready`", () => {
            const host = new RecordingHost();
            host.step({ t: 'connect', ctx: STRICT });
            const load = reduce(host.lc, { t: 'frameLoad', gen: host.lc.gen, stillOurs: true, guest: OTHER });
            expect(load.effects).toEqual([{ k: 'sendInitView', target: OTHER }]);
            host.lc = load.state;
            const ready = reduce(host.lc, { t: 'viewReady', gen: host.lc.gen, height: 100, stillStyleRefused: false });
            expect(ready.effects.map(effect => effect.k)).toEqual(['checkView', 'stopLoadDeadline', 'flush', 'startWatchdogs', 'startAutoResize', 'dispatch']);
        });
        it('in a run of each mode, every flush is the one right before its `ready`', () => {
            for (const mode of ['strict', 'cooperative', 'worker'] as const) {
                const result = runReducerSequence(sequence(mode, [...PROLOGUE, { op: 'setConfig', cfg: validConfig(mode) }, { op: 'insert' }, { op: 'settle' }, { op: 'reset' }, { op: 'settle' }]), { silentGuests: 0 });
                expect(result.ok, result.divergence).toBe(true);
                const flushes = result.log.flatMap((line, index) => (line === 'flush' ? [index] : []));
                expect(flushes.length, mode).toBe(2);
                for (const index of flushes) expect(result.log.slice(index, index + 4), mode).toEqual(['flush', 'startWatchdogs', 'startAutoResize', 'dispatch ready']);
                if (mode === 'strict') expect(result.log.indexOf('sendInitView')).toBeLessThan(flushes[0]!);
            }
        });
    });

    describe('CB5: a `terminated` listener that rebuilds a refused config', () => {
        const refused = (plan: Sequence['plans'][number]) => sequence('strict', [...PROLOGUE, { op: 'setConfig', cfg: { kind: 'unknownMode', mode: 'Strict' } }, { op: 'insert' }, { op: 'settle' }], [plan]);
        it('reset() from its listener gets the same answer, not dispatched again: one event and one warning, no recursion', () => {
            const result = runReducerSequence(refused({ event: 'terminated', action: { op: 'reset' }, times: 2 }), { silentGuests: 0 });
            expect(result.ok, result.divergence).toBe(true);
            expect(result.stats['event:terminated']).toBe(1);
            expect(result.log.filter(line => line.startsWith('warn [Sandbox] terminated:'))).toHaveLength(1);
        });
        it('control: a listener that sets a usable config builds normally', () => {
            const result = runReducerSequence(refused({ event: 'terminated', action: { op: 'setConfig', cfg: validConfig('strict') }, times: 1 }), { silentGuests: 0 });
            expect(result.ok, result.divergence).toBe(true);
            expect(result.stats['event:ready']).toBe(1);
        });
    });

    describe("round 1, R3-2: a refused build's `terminated` comes in a task, not inside setConfig() or reset()", () => {
        it('the refusal is a task, with the state `terminated` at once', () => {
            const host = new RecordingHost();
            const output = reduce(host.lc, { t: 'connect', ctx: { ...STRICT, blocked: 'refused' } });
            expect(output.state.state).toBe('terminated');
            expect(output.state.pending).toEqual({ reason: 'refused', gen: output.state.gen });
            expect(output.effects.some(isDispatch)).toBe(false);
            expect(output.effects.at(-1)).toEqual({ k: 'task', input: { t: 'buildTerminationDue', gen: output.state.gen } });
        });
        it('a listener added right after setConfig() hears it, from a task', () => {
            const heard: unknown[] = [];
            const result = runReducerSequence(sequence('strict', [...PROLOGUE, { op: 'insert' }, { op: 'settle' }, { op: 'setConfig', cfg: { kind: 'unknownMode', mode: 7 } }, { op: 'settle' }]), {
                silentGuests: 0,
                listen: (type, detail) => { if (type === 'terminated') heard.push(detail); },
            });
            expect(result.ok, result.divergence).toBe(true);
            expect(heard).toEqual([{ reason: unknownModeReason(7) }]);
        });
        it('and not at all if another build started meanwhile', () => {
            const result = runReducerSequence(sequence('strict', [...PROLOGUE, { op: 'insert' }, { op: 'settle' }, { op: 'setConfig', cfg: { kind: 'unknownMode', mode: 7 } }, { op: 'setConfig', cfg: validConfig('strict') }, { op: 'settle' }]), { silentGuests: 0 });
            expect(result.ok, result.divergence).toBe(true);
            expect(result.stats['event:terminated'] ?? 0).toBe(0);
            expect(result.stats['stale:buildTerminationDue']).toBe(1);
        });
    });
});

describe("the reducer describes today's host.ts", () => {
    it('the reasons it decides are the registry\'s (src/lib/reasons.ts), and neither it nor host.ts spells one out', () => {
        for (const file of ['src/host.ts', 'src/lib/lifecycle.ts']) {
            const source = readFileSync(path.join(ROOT, file), 'utf8');
            for (const row of Object.values(TERMINATION_REASONS)) if (row.decidedBy === 'lifecycle') expect(source, `${file}: ${row.text}`).not.toContain(row.text);
        }
        expect(reasonText('host')).toBe(DEFAULT_TERMINATE_REASON);
    });

    it('`ready`: the state is `ready` before the first effect (host.ts sets it last, unobservably), in this order', () => {
        const host = new RecordingHost();
        host.step({ t: 'connect', ctx: COOPERATIVE });
        const output = reduce(host.lc, { t: 'announced', gen: host.lc.gen, valid: true, refusal: null, port: {}, source: ANNOUNCER });
        expect(output.state.state).toBe('ready');
        expect(output.effects.map(effect => effect.k)).toEqual(['openChannel', 'stopLoadDeadline', 'flush', 'startWatchdogs', 'startAutoResize', 'dispatch']);
        expect(output.guarded).toBe(true);
    });

    it("a refused build counts two teardowns, as host.ts's initialize() (_endEnvironment, then its `buildFailed` step) does", () => {
        const output = reduce(INITIAL_LIFECYCLE, { t: 'connect', ctx: { ...STRICT, blocked: 'refused' } });
        expect(output.state.gen).toBe(2);
        expect(output.effects.filter(effect => effect.k === 'teardown')).toHaveLength(2);
    });

    it("every completion is guarded: the frame's load, the guest's check-in and the view's (S65 PR D; the view's was not before)", () => {
        const host = new RecordingHost();
        host.step({ t: 'connect', ctx: STRICT });
        const load = reduce(host.lc, { t: 'frameLoad', gen: host.lc.gen, stillOurs: true, guest: OTHER });
        expect(load.guarded).toBe(true);
        expect(reduce(load.state, { t: 'viewReady', gen: host.lc.gen, height: 1, stillStyleRefused: false }).guarded).toBe(true);
        const cooperative = new RecordingHost();
        cooperative.step({ t: 'connect', ctx: COOPERATIVE });
        expect(reduce(cooperative.lc, { t: 'announced', gen: cooperative.lc.gen, valid: true, refusal: null, port: {}, source: ANNOUNCER }).guarded).toBe(true);
    });

    it("a guarded effect's failure carries the output's generation: one that ran embedder code which built again ends nothing of the new build", () => {
        const host = new RecordingHost();
        host.step({ t: 'connect', ctx: STRICT });
        host.step({ t: 'frameLoad', gen: host.lc.gen, stillOurs: true, guest: OTHER });
        // the view's size warning, through a console.warn the page patched, resets and then throws
        host.checkView = () => {
            host.checkView = () => {};
            host.step({ t: 'build', why: 'reset', ctx: STRICT });
            throw new Error('the hook threw');
        };
        host.step({ t: 'viewReady', gen: host.lc.gen, height: 1, stillStyleRefused: false });
        expect(host.lc.state).toBe('loading');
        expect(host.events).toEqual([]);
        expect(host.log.filter(line => line === 'flush')).toEqual([]);
    });

    it('a guarded effect that throws ends the sandbox with the build-failure reason; nothing after it runs', () => {
        const host = new RecordingHost();
        host.step({ t: 'connect', ctx: COOPERATIVE });
        host.openChannel = () => { throw new Error('no port'); };
        host.step({ t: 'announced', gen: host.lc.gen, valid: true, refusal: null, port: {}, source: ANNOUNCER });
        expect(host.lc.state).toBe('terminated');
        expect(host.events).toEqual(['terminated failed (complete)']);
        expect(host.log).not.toContain('flush');
    });

    // LM-2 (S65 step 2, PR C): until PR B the reducer described today's code here, which started a second deadline for
    // the outer build and let its failure end the nested one; test/unit/lifecycle-reentry.test.ts has the element's half.
    it('LM-2: a build re-entered from inside the build effect (a host page Trusted Types default policy calling reset()): only the nested build is attached, with one deadline', () => {
        const host = new RecordingHost();
        host.onBuild = () => host.step({ t: 'build', why: 'reset', ctx: COOPERATIVE });
        host.step({ t: 'connect', ctx: COOPERATIVE });
        // the outer build prepared first and the nested one second; only the nested one, prepared second, is attached
        expect(host.log.filter(line => line.startsWith('attach') || line === 'startLoadDeadline')).toEqual(['attach {"build":2}', 'startLoadDeadline']);
        expect(host.lc.state).toBe('loading');
        // and a deadline acts only for its own build, while it is loading
        expect(isStale(host.lc, { t: 'loadDeadline', gen: (host.lc.gen - 1) as Generation })).toBe(true);
        const loading = host.lc;
        if (loading.state !== 'loading') throw new Error('not loading');
        expect(reduce({ ...loading, state: 'ready' }, { t: 'loadDeadline', gen: host.lc.gen }).effects).toEqual([]);
    });

    it('LM-2: if the outer build then throws, its failure is stale: the nested build stands, nothing is dispatched', () => {
        const host = new RecordingHost();
        host.onBuild = () => {
            host.step({ t: 'build', why: 'reset', ctx: COOPERATIVE }); // the nested build succeeds
            host.buildThrows = true; // the outer one throws once the nested one returned
        };
        host.step({ t: 'connect', ctx: COOPERATIVE });
        expect(host.lc.state).toBe('loading');
        expect(host.tasks).toEqual([]);
        expect(host.log.filter(line => line.startsWith('attach'))).toEqual(['attach {"build":2}']);
    });

    it('LM-2: an effect that runs embedder code and builds again (a warning through a patched console.warn) stops the rest of its output', () => {
        const host = readyHost();
        const warn = host.warn.bind(host);
        host.warn = (text) => {
            warn(text);
            host.warn = warn;
            host.step({ t: 'build', why: 'reset', ctx: COOPERATIVE });
        };
        host.step({ t: 'terminate', reason: 'bye' });
        // the termination's teardown and dispatch belong to an environment that is gone: the new build stands, attached
        expect(host.log.filter(line => line === 'teardown')).toHaveLength(1); // the new build's own
        expect(host.events).toEqual([]);
        expect(host.lc.state).toBe('loading');
    });

    it("the wrapper's load: a second one ends the environment; one that is no longer the element's counts for nothing", () => {
        const host = new RecordingHost();
        host.step({ t: 'connect', ctx: NO_BOOTSTRAP });
        const gen = host.lc.gen;
        expect(reduce(host.lc, { t: 'frameLoad', gen, stillOurs: false, guest: OTHER }).effects).toEqual([]);
        host.step({ t: 'frameLoad', gen, stillOurs: true, guest: OTHER });
        expect(host.lc.state).toBe('ready');
        host.step({ t: 'frameLoad', gen, stillOurs: true, guest: OTHER });
        expect(host.events).toEqual(['ready', `terminated ${reasonText('secondLoad')}`]);
    });

    it("a guest that checked in: the wrapper's load must hold its window; a second announcement ends the environment", () => {
        const host = readyHost();
        const gen = host.lc.gen;
        host.step({ t: 'frameLoad', gen, stillOurs: true, guest: ANNOUNCER });
        expect(host.lc.state).toBe('ready');
        host.step({ t: 'announced', gen, valid: true, refusal: null, port: {}, source: ANNOUNCER });
        expect(host.events).toEqual([`terminated ${reasonText('secondAnnouncement')}`]);
        const other = readyHost();
        other.step({ t: 'frameLoad', gen: other.lc.gen, stillOurs: true, guest: OTHER });
        expect(other.events).toEqual([`terminated ${reasonText('secondLoad')}`]);
    });

    it("the view's check-in counts only while loading", () => {
        const host = new RecordingHost();
        host.step({ t: 'connect', ctx: STRICT });
        host.step({ t: 'frameLoad', gen: host.lc.gen, stillOurs: true, guest: OTHER });
        host.step({ t: 'viewReady', gen: host.lc.gen, height: 1, stillStyleRefused: false });
        expect(reduce(host.lc, { t: 'viewReady', gen: host.lc.gen, height: 1, stillStyleRefused: false }).effects).toEqual([]);
        expect(host.events).toEqual(['ready']);
    });

    it("the load deadline: before the wrapper's load the frame did not load; after it, a scripted frame's startup script did not run", () => {
        const host = new RecordingHost();
        host.step({ t: 'connect', ctx: COOPERATIVE });
        expect(reduce(host.lc, { t: 'loadDeadline', gen: host.lc.gen }).effects).toContainEqual({ k: 'dispatch', event: 'terminated', reason: reasonText('loadTimeout') });
        host.step({ t: 'frameLoad', gen: host.lc.gen, stillOurs: true, guest: OTHER });
        expect(reduce(host.lc, { t: 'loadDeadline', gen: host.lc.gen }).effects).toContainEqual({ k: 'dispatch', event: 'terminated', reason: reasonText('startupBlocked') });
    });

    it('setConfig(): the same config again rebuilds nothing while the environment stands and nothing a build reads changed (R3-7)', () => {
        const host = new RecordingHost();
        host.step({ t: 'connect', ctx: COOPERATIVE });
        host.step({ t: 'setConfig', same: false });
        expect(host.lc.lastInputs).toBe(host.lc.inputs);
        expect(reduce(host.lc, { t: 'setConfig', same: true }).effects).toEqual([]);
        const changed = reduce(host.lc, { t: 'filesChanged' }).state;
        expect(reduce(changed, { t: 'setConfig', same: true }).effects).toEqual([{ k: 'applyConfig' }]);
        host.refusal = 'the configuration could not be used (TypeError)';
        host.step({ t: 'setConfig', same: false });
        expect(host.lc.lastInputs).toBeNull();
        expect(reduce(host.lc, { t: 'setConfig', same: true }).effects).toEqual([{ k: 'applyConfig' }]);
    });
});

// ---- class L in host.ts, by its source (S65 step 2) ------------------------------------------------------------------

// Class L's invariant (research 18), held by host.ts's source: every transition is a reducer input, stepped through the
// one executor; the state settles in one place (`_lc`, written by the executor only); the lifecycle's two events are
// made in one place each; queued work is released at one gate (`flush`); and the generation is compared only where the
// reducer drops a stale input and the executor stops a run, besides a call's own environment.
describe('class L in host.ts, by its source (S65 step 2)', () => {
    // Comments say what the code did before; they are not code.
    const code = (file: string) => readFileSync(path.join(ROOT, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');
    const host = code('src/host.ts');
    const lifecycle = code('src/lib/lifecycle.ts');
    // The body of a method (`private name(`, up to its closing brace) or of a module-level function or const.
    const bodyOf = (text: string, head: string, close = '\n}\n') => {
        const start = text.indexOf(head);
        expect(start, head).toBeGreaterThanOrEqual(0);
        return [start, text.indexOf(close, start)] as const;
    };
    const method = (name: string) => bodyOf(host, `    private ${name}(`, '\n    }\n');
    const inside = (index: number, [start, end]: readonly [number, number]) => index > start && index < end;
    // A comparison that involves a generation: `gen`, `.gen`, or the environment of a call (`_issuedIn`).
    const GEN_COMPARISON = /\b(?:gen|_issuedIn)\s*[!=]==|[!=]==\s*[\w.]*\bgen\b/g;

    it("'ready' and 'terminated' are made in one place each: the executor's dispatch (lifecycleHostOf); 'terminated' between its dispatchStarted and dispatchEnded steps", () => {
        const adapter = bodyOf(host, 'function lifecycleHostOf(');
        for (const event of ['ready', 'terminated']) {
            const sites = [...host.matchAll(new RegExp(`elementEvent\\('${event}'`, 'g'))].map(match => match.index!);
            expect(sites, event).toHaveLength(1);
            expect(inside(sites[0]!, adapter), event).toBe(true);
        }
        expect(host.slice(adapter[0], adapter[1])).toMatch(/dispatchTerminated: \(reason\) => \{\s*element\.dispatchEvent\(elementEvent\('terminated'/);
        expect(host.slice(adapter[0], adapter[1])).toMatch(/dispatchReady: \(\) => \{\s*element\.dispatchEvent\(elementEvent\('ready'\)\)/);
        // and the executor dispatches 'ready' only for the `dispatch ready` effect, which `enterReady` alone emits
        expect([...lifecycle.matchAll(/host\.dispatchReady\(/g)]).toHaveLength(1);
        expect([...lifecycle.matchAll(/\{ k: 'dispatch', event: 'ready' \}/g)].map(match => inside(match.index!, bodyOf(lifecycle, 'function enterReady(')))).toEqual([true]);
        // and lifecycle.ts's executor calls it only from its dispatchTerminated, inside the two steps
        const [start, end] = bodyOf(lifecycle, 'function dispatchTerminated(');
        const calls = [...lifecycle.matchAll(/host\.dispatchTerminated\(/g)].map(match => match.index!);
        expect(calls).toHaveLength(1);
        expect(calls[0]! > start && calls[0]! < end).toBe(true);
        expect(lifecycle.slice(start, end)).toMatch(/dispatchStarted[\s\S]*try[\s\S]*host\.dispatchTerminated[\s\S]*finally[\s\S]*dispatchEnded/);
        // no other file of src/ makes the event (src/lib/element-events.ts declares it)
        for (const file of ['src/lib/lifecycle.ts', 'src/lib/element-events.ts']) expect(code(file)).not.toMatch(/elementEvent\('(?:terminated|ready)'/);
    });

    it('queued work is released at one gate: _flushQueues is reached only from the `flush` effect, which only `enterReady` emits, with `dispatch ready`', () => {
        const calls = [...host.matchAll(/_flushQueues\(/g)].map(match => match.index!);
        expect(calls).toHaveLength(2); // its declaration, and the one call
        expect(inside(calls[1]!, method('_flush'))).toBe(true);
        expect([...host.matchAll(/_flush\b(?!Queues)/g)].map(match => match.index!).filter(index => !inside(index, method('_flush')))).toHaveLength(2); // LIFECYCLE's type, the adapter
        expect(host.slice(...bodyOf(host, 'function lifecycleHostOf('))).toContain('flush: () => Reflect.apply(LIFECYCLE._flush, element, [])');
        // in effect lists (the Effect type declares it once, with no comma after)
        expect([...lifecycle.matchAll(/\{ k: 'flush' \}(?=,)/g)].map(match => inside(match.index!, bodyOf(lifecycle, 'function enterReady(')))).toEqual([true]);
    });

    it('the generation is compared only in reduce and the executor, and, for a call, in _postRpc (the environment _issue records)', () => {
        const inHost = [...host.matchAll(GEN_COMPARISON)].map(match => match.index!);
        expect(inHost).toHaveLength(1);
        expect(inside(inHost[0]!, method('_postRpc'))).toBe(true);
        expect(host.slice(...method('_issue'))).toContain('this._issuedIn = this._lc.gen;');
        // lifecycle.ts: isStale and buildTerminationDue (reduce's), and tornDownSince (the executor's one comparison)
        const owners = [bodyOf(lifecycle, 'export function isStale('), bodyOf(lifecycle, 'function buildTerminationDue('), bodyOf(lifecycle, 'const tornDownSince = ', ';\n')];
        const inLifecycle = [...lifecycle.matchAll(GEN_COMPARISON)].map(match => match.index!);
        expect(inLifecycle.length).toBeGreaterThanOrEqual(3);
        for (const index of inLifecycle) expect(owners.some(owner => inside(index, owner)), lifecycle.slice(index - 60, index + 20)).toBe(true);
        // and the executor's comparison is the one runEffects and runNotices use
        expect([...lifecycle.matchAll(/tornDownSince\(host, stampGen\)/g)]).toHaveLength(2);
    });

    it('every termination the element starts carries its generation; only terminate() carries none', () => {
        const terminations = [...host.matchAll(/step\(this, \{ t: 'terminate', ([^\n]*)\}\)/g)];
        // terminate(); the watchdogs, the execution timeout, the uncaught budget, VIEW_OVERRUN, the entry failure, the host
        // page's refusals, a frame that cannot be read at its load (the reducer decides the completion's own since PR D)
        expect(terminations.length).toBeGreaterThanOrEqual(9);
        const without = terminations.filter(match => !/\bgen\b/.test(match[1]!)).map(match => match.index!);
        expect(without).toHaveLength(1);
        expect(inside(without[0]!, bodyOf(host, '    terminate(reason', '\n    }\n'))).toBe(true);
        // every other termination goes through the reducer: no `_terminate`, `_terminateBuild` or token is left
        expect(host).not.toMatch(/_terminate\(|_terminateBuild|_dispatchBuildTermination|_dispatchTerminated\(|_pendingTermination|_terminationDispatched|_notifyThenAct|_generation\b/);
        // a build's answer is the executor's alone (PR C), with its build's generation (LM-2)
        expect(host).not.toMatch(/t: 'buildFailed'|t: 'built'/);
        const answers = [...lifecycle.matchAll(/t: '(built|buildFailed)', ([^}]*)\}/g)];
        expect(answers.map(match => match[1])).toEqual(['buildFailed', 'buildFailed', 'built']); // attach's, the build's, the build's
        for (const match of answers) expect(match[2], match[0]).toMatch(/^gen: stampGen, /);
    });

    it('host.ts steps every transition, and `_lc` is written by the executor only', () => {
        const stepped = new Set([...host.matchAll(/step\((?:this|element), \{ t: '(\w+)'/g)].map(match => match[1]!));
        expect([...stepped].sort()).toEqual(['announced', 'build', 'connect', 'disconnect', 'filesChanged', 'frameLoad', 'loadDeadline', 'setConfig', 'terminate', 'viewReady']);
        // removed, each a second path or a second store of the lifecycle (PRs B to D)
        expect(host).not.toMatch(/_endEnvironment|private initialize\(|function stop\(|_buildInputs|_configRefusal|_isCurrentConfig|_enterState|_enterReady|_finishBuild|_completeBuild|_frameLoaded|_expectAnnouncement|_guestWindow|notYet/);
        // the tests' entry is not the element's (_step: the platform's inputs by hand, where jsdom cannot deliver them)
        expect(host).not.toMatch(/this\._step\(/);
        const writes = [...host.matchAll(/\._lc = |\blc = next/g)].map(match => match.index!);
        const writers = [bodyOf(host, 'function lifecycleHostOf(')];
        expect(writes).toHaveLength(1);
        for (const index of writes) expect(writers.some(writer => inside(index, writer)), host.slice(index - 40, index + 40)).toBe(true);
    });

    // LM-2: a build's resources are one set, made by the build the reducer attached and released by the teardown.
    it("LM-2: preparing a build assigns nothing on the element; every per-build resource is made by _attachBuild, or by what it alone calls", () => {
        for (const name of ['_prepareBuild', '_prepareStrictFrame']) {
            expect(host.slice(...method(name)), name).not.toMatch(/this\.\w+ = |this\._listenForAnnouncement\(|appendChild\(|this\._start\w+\(/);
        }
        // field: the methods that may give it a value other than null (the teardown, and strict mode's hand-over, clear them)
        const OWNERS: [string, string[]][] = [
            ['_iframe', ['_attachBuild']],
            ['_strictInit', ['_attachBuild']],
            ['_stopListening', ['_listenForAnnouncement']],
            ['_fetchBridge', ['_startFetchBridge']],
            ['_guestWrites', ['_startGuestWrites']],
            ['_loadDeadline', ['_startLoadDeadline']],
        ];
        for (const [field, owners] of OWNERS) {
            const sets = [...host.matchAll(new RegExp(`this\\.${field} = (?!null;|false;)`, 'g'))].map(match => match.index!);
            expect(sets.length, field).toBeGreaterThanOrEqual(1);
            for (const index of sets) expect(owners.some(owner => inside(index, method(owner))), `${field}: ${host.slice(index - 60, index + 40)}`).toBe(true);
        }
        // and those starters run from _attachBuild only, or (the deadline) from the executor's effect that follows it
        for (const starter of ['_listenForAnnouncement', '_startFetchBridge', '_startGuestWrites']) {
            const calls = [...host.matchAll(new RegExp(`this\\.${starter}\\(`, 'g'))].map(match => match.index!);
            expect(calls, starter).toHaveLength(1);
            expect(inside(calls[0]!, method('_attachBuild')), starter).toBe(true);
        }
        expect(host).not.toMatch(/this\._startLoadDeadline\(/);
        expect(host.slice(...bodyOf(host, 'function lifecycleHostOf('))).toContain('startLoadDeadline: () => Reflect.apply(LIFECYCLE._startLoadDeadline, element, [])');
    });
});
