/**
 * Runs one generated sequence (test/model/generator.ts) against the lifecycle reducer (src/lib/lifecycle.ts): the real
 * `reduce`, `step` and `runEffects`, against a fake element with a fake clock, task queue and microtask queue, and
 * feeds every observation to the same lifecycle model the e2e runner uses (test/model/lifecycle-model.ts: begin, end,
 * event, eventEnd). test/unit/lifecycle-reducer.test.ts runs thousands of sequences through it (S65).
 *
 * The fake element mirrors host.ts's adapter, reduced to what the lifecycle sees:
 * - start() reads its two arguments with the element's own reading (app-start.ts, readStart), so what it refuses is
 *   decided by the element's own rules, and a second start() throws; the files are a FileStore, as the element's are,
 *   and a build refuses a strict entry they do not hold, or one that calls import(), as host.ts's _buildRefusal does;
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
 * - the fake guest answers one kind of call, the guest's writes and removals (`act` with a `write` or `remove` step, plain
 *   arguments, the default timeout), through the element's own overlay (guest-writes.ts, createGuestWrites, over a
 *   FileStore) as host.ts's `_handleGuestWrite` does: 'fileswritten' first when the listed entry changed, then the
 *   answer, unless a listener tore the environment down. commitGuestWrites() and listGuestWrites() are the overlay's, so
 *   a committed change of the strict entry reaches the next build's refusal (`entryNotRegistered`, `entryImport`). The
 *   guest is the agent where the app's entry or markup is the agent, and answers UNKNOWN_METHOD elsewhere; a guest with
 *   no bootstrap answers nothing.
 *
 * Listener plans run as nested steps inside the dispatch, as in test/model/runner.ts. What cannot agree without a real
 * guest is filtered out (the S65 plan): every other call, and execute(), with the guest's logs and fetches and the
 * terminations a guest causes. The e2e suite (test/e2e/lifecycle-model.spec.ts) covers them.
 *
 * Besides the model's own checks, after every operation and every task the reducer's state must be the model's: the
 * same `state`, the same pending build termination, no 'terminated' still being dispatched, and the generation changed
 * exactly when the model's did (the element counts two teardowns for a refused build, the model one).
 */
import { admits, isStale, reduce, step, type BuildContext, type Generation, type LcInput, type LcOutput, type LcState, type LifecycleHost, type Notice, INITIAL_LIFECYCLE } from '../../src/lib/lifecycle';
import { readStart } from '../../src/lib/app-start';
import { DEFAULT_CALL_BUDGET, defaultConfig, hasStrictView, unknownModeReason, type CallBudget, type StoredConfig } from '../../src/lib/config-schema';
import { dynamicImportAt } from '../../src/lib/entry-imports';
import { FileStore, isJavaScriptType } from '../../src/lib/files';
import { createGuestWrites, parseCommitArguments, type GuestWrites } from '../../src/lib/guest-writes';
import { reasonText } from '../../src/lib/reasons';
import { DEFAULT_TERMINATE_REASON, LifecycleModel, RPC_SMALLEST_CALL_BYTES, type Cmd, type ConfigDesc, type GuestSpec, type Sequence, type Settlement } from './lifecycle-model';
import { Rng } from './generator';
import { AGENT_SOURCE, guestStep, listingOf, startArgumentsOf } from './runner';

export const ORIGIN = 'https://host.example';
const BUILD_FAILED = 'the environment could not be built';

/** The calls the fake guest answers: a write or a removal of the guest's, with plain arguments and the default timeout. */
function isGuestWrite(cmd: Cmd): boolean {
    if (cmd.op !== 'call' || cmd.method !== 'act' || cmd.timeout !== undefined || cmd.getter !== undefined) return false;
    if (cmd.arg !== undefined && cmd.arg !== 'plain') return false;
    return cmd.spec.k === 'write' || cmd.spec.k === 'remove';
}

/** What the unit runner leaves out: what needs a real guest to answer (the S65 plan; the e2e suite covers it). */
function needsAGuest(cmd: Cmd): boolean {
    if (cmd.op === 'execute') return true;
    return cmd.op === 'call' && !isGuestWrite(cmd);
}

/** The sequence without the operations the fake guest cannot answer, in the commands and in the listener plans. */
export function forTheReducer(sequence: Sequence): Sequence {
    const cmds = sequence.cmds.filter(cmd => !needsAGuest(cmd));
    const plans = sequence.plans.filter(plan => !needsAGuest(plan.action));
    return { ...sequence, cmds, plans };
}

/** The timeout of call() (API.md: 30 s). */
const CALL_TIMEOUT_MS = 30000;

/** One call to the fake guest, until it settles. */
interface GuestCall {
    readonly spec: GuestSpec;
    readonly gen: Generation; // the environment it was made in
    readonly settle: (outcome: Settlement) => void;
    settled: boolean;
}

/** What the guest of the standing build is, as its app makes it. */
interface FakeGuest {
    readonly bootstrap: boolean; // it answers calls at all
    readonly agent: boolean; // `act` is exposed
    readonly tinyBytes: boolean; // its own calls, its writes among them, are heavier than callLimits.maxBytesPerSecond
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
    callBudget: Readonly<CallBudget> = DEFAULT_CALL_BUDGET;
    files = new FileStore(() => {});
    frame: Frame | null = null;
    guest: FakeGuest | null = null; // the standing build's guest, from its attach to its teardown
    writes: GuestWrites | null = null; // host.ts's `_guestWrites`: made by the attach, closed at the teardown, dropped by discardWrites
    private calls: GuestCall[] = [];
    private queued: GuestCall[] = []; // made while loading: posted at the flush
    log: string[] = [];
    warns = 0;
    stats: Record<string, number> = {};
    listeners = new Map<string, ((detail: unknown) => void)[]>();
    private tasks: Task[] = [];
    private microtasks: (() => void)[] = [];
    private seq = 0;
    private frames = 0;
    private deadline: Task | null = null;
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
        this.guest = null;
        this.writes?.close(); // its writes stay listable and committable until the next build
        this.queued = [];
        // host.ts: the broker rejects every call in flight with TERMINATED
        const pending = this.calls;
        this.calls = [];
        for (const call of pending) this.settleCall(call, { status: 'rejected', code: 'TERMINATED' });
    }

    discardWrites() {
        this.log.push('discardWrites');
        this.writes?.close();
        this.writes = null;
    }

    buildContext(): BuildContext {
        const mode = this.config.mode as unknown;
        const strict = hasStrictView(mode);
        const capabilities = (this.config.capabilities ?? []) as readonly string[];
        const announces = mode === 'worker' || (mode === 'cooperative' && capabilities.includes('allow-scripts'));
        return { buildsHere: this.parent === 'own' && this.ownerDoc === 'own', blocked: unknownModeReason(mode) ?? this.entryRefusal(), strict, announces };
    }

    // host.ts, `_buildRefusal`: the entry as the files hold it now
    private entryRefusal(): string | null {
        const entry = this.config.entry;
        if (!hasStrictView(this.config.mode) || typeof entry !== 'string' || entry === '') return null;
        const file = this.files.list().find(candidate => candidate.path === entry);
        if (!file || !isJavaScriptType(file.type)) return reasonText('entryNotRegistered');
        return dynamicImportAt(this.textOf(entry) ?? '') >= 0 ? reasonText('entryImport') : null;
    }

    private textOf(path: string): string | null {
        const base64 = this.files.base64(path);
        return base64 === null ? null : new TextDecoder().decode(Uint8Array.from(atob(base64), c => c.charCodeAt(0)));
    }

    // The guest of a build, as its app makes it: the agent where the strict entry or the cooperative markup is the agent
    // (worker mode's comes by execute(), which the fake guest does not run); no bootstrap without allow-scripts.
    private guestOf(ctx: BuildContext): FakeGuest {
        const entry = this.config.entry;
        const strictAgent = ctx.strict && typeof entry === 'string' && this.textOf(entry) === AGENT_SOURCE;
        const html = this.config.html;
        const cooperativeAgent = this.config.mode === 'cooperative' && ctx.announces && typeof html === 'string' && html.includes(AGENT_SOURCE);
        const tinyBytes = this.callBudget.bytes < RPC_SMALLEST_CALL_BYTES;
        return { bootstrap: ctx.strict || ctx.announces, agent: strictAgent || cooperativeAgent, tinyBytes };
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
        this.guest = this.guestOf(ctx);
        // host.ts, `_startGuestWrites`: the overlay answers the guest from the files this build delivers
        this.writes = this.config.guestWrites === true ? createGuestWrites({ store: this.files, built: this.files.copy(), now: () => this.now }) : null;
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
    flush() {
        this.log.push('flush');
        const queued = this.queued;
        this.queued = [];
        for (const call of queued) this.post(call);
    }
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

    // host.ts, start(): the arguments read whole first (a refusal throws and stores nothing), a second call throws; the
    // app is stored and bound (`start`), the warnings said, then it builds as reset() does
    start(app: unknown, grants: unknown) {
        if (this.lc.started) throw new TypeError('[Sandbox] start(): this element already runs its app');
        const values = readStart(app, grants, { hostOrigin: ORIGIN, hostSites: [ORIGIN] });
        this.config = values.normalised.config;
        this.callBudget = values.normalised.callBudget;
        this.files = values.files;
        this.step({ t: 'start' });
        this.warns += values.warnings.length;
        this.step({ t: 'build', ctx: this.buildContext() });
    }

    reset() {
        this.step({ t: 'build', ctx: this.buildContext() });
    }

    // ---- the fake guest's one kind of call, and the overlay's two members (host.ts: call, _handleGuestWrite,
    // listGuestWrites, commitGuestWrites)

    /** call('act', spec): TERMINATED at once with no environment; queued while loading; posted while ready. */
    call(spec: GuestSpec, settle: (outcome: Settlement) => void) {
        const call: GuestCall = { spec, gen: this.lc.gen, settle, settled: false };
        if (this.lc.state !== 'loading' && this.lc.state !== 'ready') {
            this.settleCall(call, { status: 'rejected', code: 'TERMINATED' });
            return;
        }
        this.calls.push(call);
        this.schedule(CALL_TIMEOUT_MS, () => this.settleCall(call, { status: 'rejected', code: 'TIMEOUT' }));
        if (this.lc.state === 'loading') this.queued.push(call);
        else this.post(call);
    }

    private post(call: GuestCall) {
        this.schedule(this.rng.int(1, 5), () => this.answer(call));
    }

    private settleCall(call: GuestCall, outcome: Settlement) {
        if (call.settled) return;
        call.settled = true;
        this.calls = this.calls.filter(other => other !== call);
        this.queueMicrotask(() => call.settle(outcome));
    }

    // The guest runs the step, in the environment the call was made in; one with no bootstrap answers nothing.
    private answer(call: GuestCall) {
        const guest = this.guest;
        if (call.settled || call.gen !== this.lc.gen || !guest || !guest.bootstrap) return;
        if (!guest.agent) {
            this.settleCall(call, { status: 'rejected', code: 'UNKNOWN_METHOD' });
            return;
        }
        const value = this.guestWrite(call.spec as { k: 'write' | 'remove'; path: string; text?: string }, guest);
        if (value !== null) this.settleCall(call, { status: 'resolved', value });
    }

    // sandboxFiles.write() or remove() in the guest, answered by host.ts's `_handleGuestWrite`; null when a 'fileswritten'
    // listener tore the environment down before the answer (the teardown rejected the call).
    private guestWrite(spec: { k: 'write' | 'remove'; path: string; text?: string }, guest: FakeGuest): string | null {
        const writes = this.writes;
        if (!writes) return 'code:FILES_NOT_ALLOWED';
        if (guest.tinyBytes) return 'code:ARGS_NOT_TRANSFERABLE';
        const request = spec.k === 'write' ? { change: 'write', path: spec.path, entry: spec.text! } : { change: 'remove', path: spec.path };
        let recorded: ReturnType<GuestWrites['record']>;
        try {
            recorded = writes.record(request);
        } catch (error: any) {
            return `code:${error?.code}`;
        }
        if (recorded.answer.change === 'none') return 'code:NOT_FOUND';
        if (!recorded.diff.listed) return 'ok';
        const gen = this.lc.gen;
        this.dispatch('fileswritten', deepFreeze({ paths: [recorded.answer.path] }));
        return this.lc.gen === gen ? 'ok' : null;
    }

    listGuestWrites() {
        return this.writes?.list() ?? [];
    }

    commitGuestWrites(paths: unknown, options: unknown) {
        const { paths: checked, code } = parseCommitArguments(paths, options);
        if (!this.writes) return;
        const changed = this.writes.commit(checked, code);
        if (changed.length > 0) this.dispatch('fileschanged', deepFreeze({ paths: changed }));
    }

    terminate(reason?: unknown) {
        this.step({ t: 'terminate', reason: typeof reason === 'string' && reason.trim() !== '' ? reason : DEFAULT_TERMINATE_REASON });
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

    function perform(cmd: Cmd, frame: ReturnType<LifecycleModel['begin']>): ReturnType<typeof listingOf> | undefined {
        switch (cmd.op) {
            case 'insert': inDomOperation(() => el.insertInto('own')); return;
            case 'remove': inDomOperation(() => el.remove()); return;
            case 'foreign': inDomOperation(() => el.insertInto('foreign')); return;
            case 'start': el.start(...startArgumentsOf(cmd.cfg, ORIGIN, cmd.methods)); return;
            case 'reset': el.reset(); return;
            case 'terminate': el.terminate(cmd.reason); return;
            case 'call': {
                const id = frame.callId!;
                el.call(guestStep(cmd.spec), (outcome) => {
                    trace.push(`  settled call ${id}: ${JSON.stringify(outcome).slice(0, 120)}`);
                    guard(() => model.settled(id, outcome, el.now));
                });
                return;
            }
            case 'listWrites': return listingOf(el.listGuestWrites());
            case 'commit': el.commitGuestWrites(cmd.paths, { code: cmd.code }); return;
            default: return;
        }
    }

    function runOp(cmd: Cmd) {
        if (failure !== null || needsAGuest(cmd)) return;
        let frame: ReturnType<LifecycleModel['begin']>;
        try {
            // a commit is predicted from the pending list, as runner.ts does
            frame = model.begin(cmd, el.now, cmd.op === 'commit' ? { listed: listingOf(el.listGuestWrites()) } : undefined);
        } catch (error) {
            fail(error);
            return;
        }
        depth++;
        const warnsBefore = el.warns;
        let threw: string | null = null;
        let listed: ReturnType<typeof perform>;
        try {
            listed = perform(cmd, frame);
        } catch (error: any) {
            threw = String(error?.code ?? error?.name ?? error);
        }
        depth--;
        guard(() => model.end(frame, { threw, warned: el.warns - warnsBefore, state: el.lc.state, listed }));
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
