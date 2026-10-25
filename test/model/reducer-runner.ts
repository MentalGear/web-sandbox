/**
 * Runs one generated sequence (test/model/generator.ts) against the lifecycle reducer (src/lib/lifecycle.ts): the real
 * `reduce`, `step` and `runEffects`, against a fake element with a fake clock, task queue and microtask queue, and
 * feeds every observation to the same lifecycle model the e2e runner uses (test/model/lifecycle-model.ts: begin, end,
 * event, eventEnd). test/unit/lifecycle-reducer.test.ts runs thousands of sequences through it (S65).
 *
 * The fake element mirrors host.ts's adapter, reduced to what the lifecycle sees:
 * - setConfig() clones the argument and applies it with the real config schema (normaliseConfig), so a refusal, an
 *   unknown mode and a strict entry are decided by the element's own rules; the files are a map of paths;
 * - a build makes a fake frame whose guest checks in after a few ms of fake time (a seeded delay): the strict view's
 *   VIEW_READY after it got its ports at the wrapper's load, the bootstrap's announcement in cooperative and worker
 *   mode, the wrapper's load alone without a bootstrap. One build in 40 has a guest that never checks in, so the load
 *   deadline ends it (as the host page's policy would);
 * - the wrapper's load handler queues a microtask, as host.ts's `_frameLoadHandler` does (R4:L-1), and a
 *   frame also fires its load inside the embedder's appendChild() or remove() of the element, before the element's
 *   lifecycle reactions, as Chromium and WebKit do;
 * - nothing the fake guest or the fake timers deliver is cancelled at a teardown (only the load deadline at `ready`,
 *   which host.ts stops there): announcements, check-ins, loads and deadlines of environments that are gone arrive
 *   with their generation, and the reducer must drop them. That is stronger than the element, whose listeners and
 *   ports go with their environment (AR:B4).
 *
 * Listener plans run as nested steps inside the dispatch, as in test/model/runner.ts. What cannot agree without a guest
 * is filtered out (the S65 plan): calls, execute(), commitGuestWrites() and listGuestWrites(), with the guest's logs,
 * writes and fetches and the terminations a guest causes. The e2e suite (test/e2e/lifecycle-model.spec.ts) covers them.
 *
 * Besides the model's own checks, after every operation and every task the reducer's state must be the model's: the
 * same `state`, the same pending build termination, no 'terminated' still being dispatched, and the generation changed
 * exactly when the model's did (the element counts two teardowns for a refused build, the model one).
 */
import { refusalDetail } from '../../src/lib/csp/origins';
import { admits, isStale, reduce, step, type BuildContext, type Generation, type LcInput, type LcOutput, type LcState, type LifecycleHost, type Notice, INITIAL_LIFECYCLE } from '../../src/lib/lifecycle';
import { defaultConfig, normaliseConfig, unknownModeReason, type StoredConfig } from '../../src/lib/config-schema';
import { isJavaScriptType, mimeTypeFor } from '../../src/lib/files';
import { CONFIG_REFUSED, DEFAULT_TERMINATE_REASON, LifecycleModel, type Cmd, type ConfigDesc, type Sequence } from './lifecycle-model';
import { Rng } from './generator';
import { configOf } from './runner';

export const ORIGIN = 'https://host.example';
const BUILD_FAILED = 'the environment could not be built';

/** What the unit runner leaves out: what needs a guest to answer (the S65 plan; the e2e suite covers it). */
const NEEDS_A_GUEST = new Set<Cmd['op']>(['call', 'execute', 'commit', 'listWrites']);

/** The sequence without the operations a fake guest cannot answer, in the commands and in the listener plans. */
export function forTheReducer(sequence: Sequence): Sequence {
    const cmds = sequence.cmds.filter(cmd => !NEEDS_A_GUEST.has(cmd.op));
    const plans = sequence.plans.filter(plan => !NEEDS_A_GUEST.has(plan.action.op));
    return { ...sequence, cmds, plans };
}

export interface ReducerRunOptions {
    /** Every step, with the state before it and the reducer's output (recomputed: `reduce` is pure). */
    onStep?: (before: LcState, input: LcInput, output: LcOutput) => void;
    /** A listener of the test's own, after the model's first listener and the plans. */
    listen?: (type: string, detail: unknown, element: FakeElement) => void;
    /** The adapter R4:L-1 rules out, for the model to catch: the wrapper's load completes the build in the load event itself. */
    syncFrameLoad?: boolean;
    /** Whether a frame fires its load inside the embedder's appendChild() or remove() (Chromium, WebKit). Default true. */
    loadInsideDomOperations?: boolean;
    /** The chance that a build's guest never checks in (default 1 in 40). */
    silentGuests?: number;
}

export interface ReducerRunResult {
    ok: boolean;
    divergence?: string;
    step?: number;
    trace: string[];
    log: string[];
    stats: Record<string, number>;
    coverage: string[];
}

interface Task {
    at: number;
    seq: number;
    run: () => void;
    cancelled: boolean;
}

interface Frame {
    id: number;
    gen: Generation; // the generation it was built in
    silent: boolean;
    connected: boolean;
    onload: (() => void) | null;
    guest: object; // its guest frame's window, as an identity (host.ts: the wrapper's frames[0])
}

const errorName = (error: unknown): string => {
    if (error === null) return 'null';
    if (typeof error !== 'object' && typeof error !== 'function') return typeof error;
    const name = (error as { name?: unknown }).name;
    return typeof name === 'string' && /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(name) ? name : 'Error';
};

const deepFreeze = <T>(value: T): T => {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
        for (const key of Object.keys(value)) deepFreeze((value as Record<string, unknown>)[key]);
        Object.freeze(value);
    }
    return value;
};

/** The fake element: the lifecycle host, a fake DOM position, a fake guest and the fake event loop. */
export class FakeElement implements LifecycleHost {
    lc: LcState = INITIAL_LIFECYCLE;
    now = 0;
    parent: 'none' | 'own' | 'foreign' = 'none';
    ownerDoc: 'own' | 'foreign' = 'own';
    config: StoredConfig = defaultConfig();
    files: Record<string, string> = {};
    frame: Frame | null = null;
    log: string[] = [];
    warns = 0;
    stats: Record<string, number> = {};
    listeners = new Map<string, ((detail: unknown) => void)[]>();
    private tasks: Task[] = [];
    private microtasks: (() => void)[] = [];
    private seq = 0;
    private frames = 0;
    private deadline: Task | null = null;
    private lastKey: string | null = null; // the last usable setConfig() argument, as data (host.ts: `_lastConfig.copy`)
    private pendingCopy: { copy: unknown; error: unknown; key: string } | null = null;
    private warnedForeign = false;
    private lastSilent = false;
    lastBuildAt = 0;
    private readonly rng: Rng;

    constructor(seed: number, readonly options: ReducerRunOptions = {}) {
        this.rng = new Rng(seed ^ 0x5eed);
    }

    count(key: string) {
        this.stats[key] = (this.stats[key] ?? 0) + 1;
    }

    // ---- the event loop

    schedule(delay: number, run: () => void): Task {
        const task: Task = { at: this.now + delay, seq: this.seq++, run, cancelled: false };
        this.tasks.push(task);
        return task;
    }

    queueMicrotask(run: () => void) {
        this.microtasks.push(run);
    }

    drainMicrotasks() {
        while (this.microtasks.length > 0) this.microtasks.shift()!();
    }

    private nextTask(): Task | null {
        let next: Task | null = null;
        for (const task of this.tasks) {
            if (task.cancelled) continue;
            if (!next || task.at < next.at || (task.at === next.at && task.seq < next.seq)) next = task;
        }
        return next;
    }

    /** Runs the next task due by `limit`, then the microtasks; false when there is none. */
    runOneTask(limit: number, after: () => void): boolean {
        const task = this.nextTask();
        if (!task || task.at > limit) return false;
        this.tasks.splice(this.tasks.indexOf(task), 1);
        this.now = Math.max(this.now, task.at);
        task.run();
        this.drainMicrotasks();
        after();
        return true;
    }

    // ---- the executor's entry

    step(input: LcInput) {
        const before = this.lc;
        this.count(`input:${input.t}`);
        // the fake element delivers only what the reducer's declaration admits (LC_INPUTS); reduce throws on anything else
        if (!isStale(before, input) && !admits(before, input)) throw new Error(`the fake element stepped ${input.t} in ${before.state}, which LC_INPUTS does not admit`);
        if (this.options.onStep) this.options.onStep(before, input, reduce(before, input));
        step(this, input);
        if (isStale(before, input)) this.count(`stale:${input.t}`);
    }

    task(input: LcInput) {
        this.schedule(0, () => this.step(input));
    }

    // ---- the host's resources

    teardown() {
        this.log.push('teardown');
        if (this.frame) {
            this.frame.onload = null;
            this.frame.connected = false;
        }
        this.frame = null;
    }

    discardWrites() {
        this.log.push('discardWrites');
    }

    applyConfig(): string | null {
        const pending = this.pendingCopy!;
        this.pendingCopy = null;
        const refuse = (error: unknown) => {
            this.lastKey = null;
            return `${CONFIG_REFUSED} (${errorName(error)}${refusalDetail(error)})`;
        };
        if (pending.error !== null) return refuse(pending.error);
        const { value, warnings, refusal } = normaliseConfig(pending.copy, { hostOrigin: ORIGIN, hostSites: [ORIGIN] });
        this.warns += warnings.length;
        if (value === null) return refuse(refusal);
        this.config = value.config;
        this.lastKey = pending.key;
        return null;
    }

    buildContext(): BuildContext {
        const mode = this.config.mode as unknown;
        const strict = mode === 'strict';
        const capabilities = (this.config.capabilities ?? []) as readonly string[];
        const announces = mode === 'worker' || (mode === 'cooperative' && capabilities.includes('allow-scripts'));
        return { buildsHere: this.parent === 'own' && this.ownerDoc === 'own', blocked: unknownModeReason(mode) ?? this.entryRefusal(), strict, announces };
    }

    private entryRefusal(): string | null {
        const entry = this.config.entry;
        if (this.config.mode !== 'strict' || typeof entry !== 'string' || entry === '') return null;
        if (entry in this.files && isJavaScriptType(mimeTypeFor(entry))) return null;
        return `the guest entry "${entry.slice(0, 256)}" is not a registered JavaScript file`;
    }

    // host.ts, `_prepareBuild`: a frame the element does not hold yet
    build(): Frame {
        // never two silent guests in a row: a rebuild from the deadline's 'terminated' listener must settle within 8 s
        const silent = !this.lastSilent && this.rng.chance(this.options.silentGuests ?? 1 / 40);
        this.lastSilent = silent;
        const id = ++this.frames;
        return { id, gen: this.lc.gen, silent, connected: true, onload: null, guest: { guestOf: id } };
    }

    // host.ts, `_attachBuild`: the frame becomes the element's, and its guest starts
    attach(prepared: unknown) {
        const frame = prepared as Frame;
        const ctx = this.buildContext();
        frame.onload = this.loadHandler(frame);
        this.frame = frame;
        this.lastBuildAt = this.now;
        this.log.push(`build #${frame.id}${frame.silent ? ' (silent)' : ''}`);
        // the wrapper's one load, and the guest's announcement, in either order (S46: usually the announcement first)
        this.schedule(this.rng.int(1, 20), () => frame.onload?.());
        if (ctx.announces && !frame.silent) {
            this.schedule(this.rng.int(1, 20), () => {
                this.step({ t: 'announced', gen: frame.gen, valid: true, refusal: null, port: { frame: frame.id }, source: frame.guest });
            });
        }
    }

    // host.ts, `_frameLoadHandler`: the load counts in a microtask, for the element's current frame while both are in the
    // document, in the environment the load event found.
    private loadHandler(frame: Frame) {
        return () => {
            const gen = this.lc.gen;
            const deliver = () => this.step({
                t: 'frameLoad',
                gen,
                stillOurs: frame === this.frame && frame.connected && this.parent !== 'none',
                guest: frame.guest,
            });
            if (this.options.syncFrameLoad) deliver();
            else this.queueMicrotask(deliver);
        };
    }

    failureReason(error: unknown): string {
        return `${BUILD_FAILED} (${errorName(error)})`;
    }

    startLoadDeadline() {
        const gen = this.lc.gen;
        this.deadline = this.schedule(5000, () => this.step({ t: 'loadDeadline', gen }));
    }

    stopLoadDeadline() {
        if (this.deadline) this.deadline.cancelled = true;
        this.deadline = null;
    }

    sendInitView() {
        const frame = this.frame!;
        this.log.push('sendInitView');
        if (frame.silent) return;
        this.schedule(this.rng.int(1, 10), () => this.step({ t: 'viewReady', gen: frame.gen, height: 120, stillStyleRefused: false }));
    }

    openChannel() { this.log.push('openChannel'); }
    closePort() { this.log.push('closePort'); }
    checkView() { this.log.push('checkView'); }
    flush() { this.log.push('flush'); }
    startWatchdogs() { this.log.push('startWatchdogs'); }
    startAutoResize() { this.log.push('startAutoResize'); }

    warn(text: string) {
        this.warns++;
        this.log.push(`warn ${text}`);
    }

    warnForeignDocument() {
        if (this.warnedForeign) return;
        this.warnedForeign = true;
        this.warns++;
    }

    dispatchReady() {
        this.log.push('dispatch ready');
        this.dispatch('ready', null);
    }

    dispatchTerminated(reason: string) {
        this.log.push(`dispatch terminated ${reason}`);
        this.dispatch('terminated', deepFreeze({ reason }));
    }

    notice(notice: Notice) {
        this.log.push(`notice ${notice.source} ${notice.text}`);
        this.dispatch('sandbox-log', deepFreeze({ level: notice.level, args: [notice.text], source: notice.source }));
    }

    dispatch(type: string, detail: unknown) {
        this.count(`event:${type}`);
        for (const listener of [...(this.listeners.get(type) ?? [])]) listener(detail);
    }

    on(type: string, listener: (detail: unknown) => void) {
        const list = this.listeners.get(type) ?? [];
        list.push(listener);
        this.listeners.set(type, list);
    }

    // ---- the public API and the DOM, as host.ts's adapter will step them

    setConfig(config: unknown, key: string) {
        let copy: unknown = null;
        let error: unknown = null;
        try {
            copy = structuredClone(config);
        } catch (caught) {
            error = caught;
        }
        this.pendingCopy = { copy, error, key };
        this.step({ t: 'setConfig', same: error === null && this.lastKey !== null && key === this.lastKey });
    }

    load(html: string) {
        this.config = { ...this.config, html };
        this.step({ t: 'build', why: 'load', ctx: this.buildContext() });
    }

    reset() {
        this.step({ t: 'build', why: 'reset', ctx: this.buildContext() });
    }

    terminate(reason?: unknown) {
        this.step({ t: 'terminate', reason: typeof reason === 'string' && reason.trim() !== '' ? reason : DEFAULT_TERMINATE_REASON });
    }

    registerFiles(files: Record<string, string>) {
        const changed: string[] = [];
        for (const [path, text] of Object.entries(files)) {
            if (this.files[path] === text) continue;
            this.files[path] = text;
            changed.push(path);
        }
        this.filesChanged(changed);
    }

    unregisterFiles(paths?: string[]) {
        const removed: string[] = [];
        for (const path of paths ?? Object.keys(this.files)) {
            if (!(path in this.files)) continue;
            delete this.files[path];
            removed.push(path);
        }
        this.filesChanged(removed);
    }

    private filesChanged(paths: string[]) {
        if (paths.length === 0) return;
        this.step({ t: 'filesChanged' });
        this.dispatch('fileschanged', deepFreeze({ paths }));
    }

    // A frame's load inside the embedder's own DOM call, before the element's lifecycle reactions (Chromium, WebKit).
    private loadDuringDomOperation() {
        if (this.options.loadInsideDomOperations === false) return;
        this.frame?.onload?.();
    }

    /** appendChild() into `target`: removal from where it is, adoption into another document, insertion. */
    insertInto(target: 'own' | 'foreign') {
        if (this.parent !== 'none') {
            this.loadDuringDomOperation();
            this.step({ t: 'disconnect' });
        }
        if (this.ownerDoc !== target) {
            this.ownerDoc = target;
            this.step({ t: 'disconnect' }); // adoptedCallback: stop() too
        }
        this.parent = target;
        this.step({ t: 'connect', ctx: this.buildContext() });
    }

    remove() {
        if (this.parent === 'none') return;
        this.loadDuringDomOperation();
        this.parent = 'none';
        this.step({ t: 'disconnect' });
    }
}

const html = (agent: boolean) => (agent ? '<script>agent</script>' : '<p>plain</p>');

/** One sequence against the reducer; every observation goes to a fresh lifecycle model. */
export function runReducerSequence(sequence: Sequence, options: ReducerRunOptions = {}): ReducerRunResult {
    const model = new LifecycleModel(sequence.mode);
    const el = new FakeElement(sequence.seed, options);
    const trace: string[] = [];
    let failure: string | null = null;
    let failedAt = -1;
    let at = -1;
    let depth = 0;
    let inDom = false;

    const fail = (error: unknown) => {
        if (failure !== null) return;
        failure = error instanceof Error ? error.message : String(error);
        failedAt = at;
    };
    const guard = (action: () => void) => {
        if (failure !== null) return;
        try {
            action();
        } catch (error) {
            fail(error);
        }
    };

    for (const type of ['ready', 'terminated', 'sandbox-log', 'fileswritten', 'fetch', 'fileschanged']) {
        el.on(type, (detail) => guard(() => {
            trace.push(`  ${'  '.repeat(depth)}event ${type} ${JSON.stringify(detail)}`);
            model.event({ type, detail, depth, inDom, state: el.lc.state, frozen: detail === null || Object.isFrozen(detail), now: el.now });
        }));
        for (const plan of sequence.plans.filter(candidate => candidate.event === type)) {
            let left = plan.times;
            el.on(type, () => {
                if (left <= 0 || failure !== null) return;
                left--;
                trace.push(`  ${'  '.repeat(depth)}plan on ${type}: ${JSON.stringify(plan.action)}`);
                runOp(plan.action);
            });
        }
        if (options.listen) el.on(type, (detail) => options.listen!(type, detail, el));
        el.on(type, () => guard(() => model.eventEnd(type)));
    }

    const inDomOperation = (action: () => void) => {
        const outer = inDom;
        inDom = true;
        try {
            action();
        } finally {
            inDom = outer;
        }
    };

    function perform(cmd: Cmd) {
        switch (cmd.op) {
            case 'insert': inDomOperation(() => el.insertInto('own')); return;
            case 'remove': inDomOperation(() => el.remove()); return;
            case 'foreign': inDomOperation(() => el.insertInto('foreign')); return;
            case 'setConfig': el.setConfig(configOf(cmd.cfg, ORIGIN), JSON.stringify(cmd.cfg)); return;
            case 'setConfigEqual': el.setConfig(configOf(model.lastDesc!, ORIGIN), JSON.stringify(model.lastDesc)); return;
            case 'load': el.load(html(cmd.agent)); return;
            case 'reset': el.reset(); return;
            case 'terminate': el.terminate(cmd.reason); return;
            case 'register': el.registerFiles(cmd.files); return;
            case 'registerBad': throw Object.assign(new Error('the path is outside the store'), { code: 'INVALID_PATH' });
            case 'unregister': el.unregisterFiles(cmd.paths); return;
            default: return; // expose(): host methods are not the lifecycle's
        }
    }

    function runOp(cmd: Cmd) {
        if (failure !== null || NEEDS_A_GUEST.has(cmd.op)) return;
        if (cmd.op === 'setConfigEqual' && !model.lastDesc) return;
        let frame: ReturnType<LifecycleModel['begin']>;
        try {
            frame = model.begin(cmd, el.now);
        } catch (error) {
            fail(error);
            return;
        }
        depth++;
        const warnsBefore = el.warns;
        let threw: string | null = null;
        try {
            perform(cmd);
        } catch (error: any) {
            threw = String(error?.code ?? error?.name ?? error);
        }
        depth--;
        guard(() => model.end(frame, { threw, warned: el.warns - warnsBefore, state: el.lc.state }));
    }

    // The reducer's state against the model's, once nothing runs.
    let genBefore = { model: model.gen, lc: el.lc.gen };
    const compare = (what: string) => guard(() => {
        const lc = el.lc;
        if (lc.state !== model.state) throw new Error(`${what}: the reducer is ${lc.state}, the model ${model.state}`);
        const pending = lc.pending?.reason ?? null;
        const modelPending = model.pendingTermination?.reason ?? null;
        if (pending !== modelPending) throw new Error(`${what}: the reducer's pending termination is ${JSON.stringify(pending)}, the model's ${JSON.stringify(modelPending)}`);
        if (lc.dispatching.length !== 0 || model.dispatching.length !== 0) throw new Error(`${what}: a 'terminated' is still being dispatched (${JSON.stringify(lc.dispatching)}, model ${JSON.stringify(model.dispatching)})`);
        const changed = lc.gen !== genBefore.lc;
        const modelChanged = model.gen !== genBefore.model;
        if (changed !== modelChanged) throw new Error(`${what}: the reducer's generation ${changed ? 'changed' : 'did not change'}, the model's ${modelChanged ? 'did' : 'did not'}`);
        genBefore = { model: model.gen, lc: lc.gen };
    });
    const runTasksUntil = (limit: number, stop: () => boolean = () => false) => {
        while (failure === null && !stop() && el.runOneTask(limit, () => compare(`a task at ${el.now} ms`)));
    };

    for (at = 0; at < sequence.cmds.length && failure === null; at++) {
        const cmd = sequence.cmds[at]!;
        trace.push(`#${at} [${model.state}] ${JSON.stringify(cmd)}`);
        if (cmd.op === 'wait') {
            runTasksUntil(el.now + cmd.ms);
            el.now = Math.max(el.now, el.now + cmd.ms);
        } else if (cmd.op === 'settle') {
            // 8 s, as runner.ts, from the settle or from the last build a listener started meanwhile (a fake guest goes
            // silent only at a build, and listener plans run a bounded number of times)
            const from = el.now;
            const limit = () => Math.max(from, el.lastBuildAt) + 8000;
            while (failure === null && !model.quiet && el.runOneTask(limit(), () => compare(`a task at ${el.now} ms`)));
            if (!model.quiet) fail(`settle: still ${model.state} after 8 s (pending ${JSON.stringify(model.pendingTermination)})`);
            runTasksUntil(el.now + 20);
            el.now += 20;
        } else {
            runOp(cmd);
            el.drainMicrotasks();
            compare(`#${at} ${cmd.op}`);
        }
    }
    at = sequence.cmds.length;
    // the end of a sequence, as runner.ts: let it run on, remove the element, then nothing more is dispatched
    runTasksUntil(el.now + 300);
    el.now += 300;
    runOp({ op: 'remove' });
    el.drainMicrotasks();
    compare('the final removal');
    runTasksUntil(el.now + 6000);
    guard(() => model.finish());
    return {
        ok: failure === null,
        ...(failure !== null ? { divergence: failure, step: failedAt } : {}),
        trace: trace.slice(-60),
        log: el.log,
        stats: el.stats,
        coverage: [...model.coverage],
    };
}

/** The descriptor of a valid config, for hand-written traces. */
export const validConfig = (mode: 'strict' | 'cooperative' | 'worker', extra: Partial<Extract<ConfigDesc, { kind: 'valid' }>> = {}): ConfigDesc => ({
    kind: 'valid', mode, scriptUnsafe: true, guestWrites: false, watchdog: undefined, execTimeout: undefined, html: 'agent', fetch: false, limits: 'none', variant: 0,
    ...(mode === 'strict' ? { entry: 'agent.js' as const } : {}),
    ...extra,
});
