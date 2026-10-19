/**
 * The lifecycle reference model of `<web-sandbox>` (backlog S61.2, S65), written from README.md and docs/API.md as they
 * stand at 446017a: docs/research/17_formal_methods/lifecycle-model.md describes how review rounds 4 and 5 used it.
 *
 * Pure TypeScript, no DOM: the model's state, one transition per operation (its preconditions, the state it leads to and
 * the events it must dispatch synchronously) and the checks on what the element is observed to do afterwards (events
 * from tasks, call settlements, guest-write announcements). test/model/runner.ts drives the real element in a page and
 * feeds every observation here; test/unit/lifecycle-model.test.ts checks the model itself on the round reports' traces.
 *
 * Phase 1's rules (review round 5, S64) that the model holds the element to:
 * - `ready` is the only flush point: a call made while `loading` that settles before `ready` (its timeout) never runs;
 * - one "no repeat" rule for every `terminated`: a build started while a `terminated` is dispatched and refused with that
 *   very reason ends `terminated` without another event;
 * - every event detail is frozen, deeply;
 * - a guest call heavier than `callLimits.maxBytesPerSecond` is `ARGS_NOT_TRANSFERABLE`, and so is every guest write then;
 * - one diff for guest writes: exactly one `fileswritten` per change of what `listGuestWrites()` shows at a path;
 * - the autonomous terminations (watchdog, `workerExecutionTimeout`, entry failure, the load deadline) only when the
 *   environment allows them. The uncaught budget, `VIEW_MAX_OPERATION_MS` and `VIEW_MAX_DISTINCT_URLS` are never
 *   approached by the generator, so their terminations are divergences here (they have their own specs). The view's
 *   first overrun (backlog S72) is a host line allowed in any standing strict environment: it is wall time, which a
 *   loaded machine can push past the limit, and it changes no state; the second overrun's termination stays a divergence.
 */

export type Mode = 'strict' | 'cooperative' | 'worker';
export type Where = 'none' | 'own' | 'foreign';
export type State = 'idle' | 'loading' | 'ready' | 'terminated';

/** A raw option value as the generator writes it: JSON has no NaN or Infinity, so those are tokens. */
export type Raw = number | string | boolean | null;

/** A config as a descriptor; the runner turns it into the object setConfig() gets (configOf). */
export type ConfigDesc =
    | {
          kind: 'valid';
          mode: Mode;
          scriptUnsafe: Raw; // only a literal true enables it
          guestWrites: Raw; // only a literal true enables it
          watchdog: Raw | undefined;
          execTimeout: Raw | undefined;
          entry?: 'agent.js' | 'bad.js' | 'missing.js';
          html: 'agent' | 'plain' | 'none';
          noScripts?: boolean; // cooperative mode without allow-scripts: no bootstrap
          fetch: boolean;
          limits: 'none' | 'tinyBytes' | 'fewCalls' | 'bogus';
          variant: number; // distinguishes otherwise equal configs, so "the same config again" is a deliberate step
      }
    | { kind: 'unknownMode'; mode: string | number }
    | { kind: 'unusable'; why: 'function' | 'notObject' | 'origins' | 'originsList' };

/** A guest step, run by the agent's `act(spec)`; `env` and `id` are filled in by the runner. */
export type GuestSpec =
    | { k: 'mark' }
    | { k: 'log'; n: number }
    | { k: 'throw' }
    | { k: 'uncaught' }
    | { k: 'busy'; ms: number }
    | { k: 'wait'; ms: number }
    | { k: 'write'; path: string; text: string }
    | { k: 'remove'; path: string }
    | { k: 'fetch' }
    | { k: 'bgfetch' }
    | { k: 'callHost' }
    | { k: 'expose' };

export type ArgKind = 'plain' | 'function' | 'error' | 'getterThrow' | 'getter';

export type Cmd =
    | { op: 'insert' } // into the defining document (a move when it is already there; back from a foreign one)
    | { op: 'remove' }
    | { op: 'foreign' } // into a document of another window (an iframe's)
    | { op: 'setConfig'; cfg: ConfigDesc }
    | { op: 'setConfigEqual' } // the last setConfig() argument again, as a fresh copy
    | { op: 'load'; agent: boolean }
    | { op: 'reset' }
    | { op: 'terminate'; reason: Raw | undefined }
    | { op: 'register'; files: Record<string, string> }
    | { op: 'registerBad' }
    | { op: 'unregister'; paths?: string[] }
    | { op: 'expose'; variant: 'echo' | 'throw' }
    | { op: 'call'; method: 'act' | 'missing' | 'long'; spec: GuestSpec; timeout?: Raw; arg?: ArgKind; getter?: Cmd }
    | { op: 'execute'; code: 'agent' | 'mark' | 'busy' | 'nonstring' }
    | { op: 'listWrites' }
    | { op: 'commit'; paths: string[]; code: boolean }
    | { op: 'wait'; ms: number }
    | { op: 'settle' };

export type PlanEvent = 'ready' | 'terminated' | 'sandbox-log' | 'fileswritten' | 'fetch';
/** A re-entrant listener plan: the first `times` dispatches of `event` run `action` inside the listener. */
export interface Plan {
    event: PlanEvent;
    action: Cmd;
    times: number;
}

export interface Sequence {
    seed: number;
    mode: Mode;
    plans: Plan[];
    cmds: Cmd[];
}

// ---- documented texts and numbers --------------------------------------------------------------------------------

export const DEFAULT_TERMINATE_REASON = 'terminated by the host';
export const CONFIG_REFUSED = 'the configuration could not be used';
export const WATCHDOG_REASON = 'the guest stopped responding (watchdog)';
export const EXECUTION_TIMEOUT_REASON = 'the executed code ran longer than workerExecutionTimeout';
export const ENTRY_FAILED_REASON = 'the guest entry failed to start';
export const LOAD_TIMEOUT_REASONS = [
    'the sandbox did not finish loading',
    "the sandbox's startup script did not run: the host page's Content-Security-Policy must allow it (see docs/API.md#host-page-policy)",
];
export const LOAD_TIMEOUT_MS = 5000;
export const RPC_SMALLEST_CALL_BYTES = 136; // "the smallest call measures about 136 bytes"
export const TINY_BYTES_BUDGET = 64; // below that: every guest call is ARGS_NOT_TRANSFERABLE
export const FEW_CALLS_BUDGET = 3;
export const AGENT_PATH = 'agent.js';
export const BAD_ENTRY_PATH = 'bad.js';

/** What setConfig() receives for a raw token. */
export function rawValue(raw: Raw | undefined): unknown {
    if (raw === 'NaN') return NaN;
    if (raw === 'Infinity') return Infinity;
    if (raw === '-Infinity') return -Infinity;
    return raw;
}

/** "Anything but a finite number > 0 is off" (watchdogTimeout, workerExecutionTimeout). */
export function positiveTimeout(raw: Raw | undefined): number {
    const value = rawValue(raw);
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

/** callWithTimeout(): "0 (or any value that is not > 0) disables it, and so does Infinity"; call() waits 30 s. */
export function callTimeout(raw: Raw | undefined, explicit: boolean): number {
    if (!explicit) return 30000;
    const value = rawValue(raw);
    return typeof value === 'number' && value > 0 && value !== Infinity ? value : Infinity;
}

const INERT_EXTENSIONS = ['txt', 'json', 'css', 'png'];
export function isInertPath(path: string): boolean {
    return INERT_EXTENSIONS.includes(path.split('.').pop() ?? '');
}

/** The reason a refused config gives (the error's name only). */
export function refusalOf(desc: ConfigDesc): string | null {
    if (desc.kind !== 'unusable') return null;
    return `${CONFIG_REFUSED} (${desc.why === 'function' ? 'DataCloneError' : 'TypeError'})`;
}

export function unknownModeReason(mode: string | number): string {
    const shown = typeof mode === 'string' ? JSON.stringify(mode.slice(0, 32)) : `of type ${typeof mode}`;
    return `unknown mode ${shown}${mode === 'iframe' ? " ('iframe' was renamed 'cooperative')" : ''}`;
}

// ---- the model -------------------------------------------------------------------------------------------------

export interface Env {
    id: number;
    mode: Mode;
    agent: boolean; // act() is exposed in the guest
    bootstrap: boolean; // calls can be answered at all
    ready: boolean;
    startedAt: number;
    busy: boolean; // a guest step blocked its event loop
    execBusy: boolean; // an execute() blocked it
    entryBad: boolean;
    guestWrites: boolean;
    tinyBytes: boolean;
    fewCalls: boolean;
    fetch: boolean;
    watchdog: number;
    execTimeout: number;
    built: Record<string, string>; // the files this build delivered
}

export type Pending = { change: 'write'; text: string } | { change: 'remove' };

export interface CallRecord {
    id: number;
    method: string;
    spec: GuestSpec;
    timeout: number;
    t0: number;
    gen0: number;
    envId: number | null;
    // decided at call time
    immediate: string | null; // the one outcome allowed (TERMINATED, INVALID_CALL, ARGS_NOT_TRANSFERABLE)
    agent: boolean;
    bootstrap: boolean;
    concurrentPath: boolean; // another write to the same path was in flight
    announcedBefore: number;
    settled: boolean;
    exposes: number; // host expose() calls before it
    applied: 0 | 1 | 'uncertain' | null; // a guest write's change, applied at its fileswritten
}

export interface Observation {
    type: string;
    detail: any;
    depth: number; // operation frames open when it was dispatched (0: from a task)
    inDom: boolean; // inside the embedder's appendChild()/remove()
    state: string; // el.state inside the first listener
    frozen: boolean; // deeply frozen
    now: number;
    listed?: { path: string; change: string }[]; // listGuestWrites() at a fileswritten
}

export interface Frame {
    cmd: Cmd;
    expected: { type: string; reason?: string; paths?: string[] }[];
    gen0: number;
    expectThrow: string | null; // the error code the call must throw
    expectWarn: boolean;
    callId?: number;
    getterMustNotRun?: boolean;
    getterRan?: boolean;
    executed?: { accepted: boolean; id: number };
}

export interface Settlement {
    status: 'resolved' | 'rejected';
    value?: unknown;
    code?: unknown;
}

export class Divergence extends Error {}

export const OPS = ['insert', 'remove', 'foreign', 'setConfig', 'setConfigEqual', 'load', 'reset', 'terminate', 'register', 'registerBad', 'unregister', 'expose', 'call', 'callWithTimeout', 'execute', 'listWrites', 'commit', 'guest'] as const;
export const STATES: State[] = ['idle', 'loading', 'ready', 'terminated'];

/** The operation a command counts as for coverage. */
export function opName(cmd: Cmd): string {
    if (cmd.op === 'call') {
        if (cmd.method === 'act' && cmd.spec.k !== 'mark') return 'guest';
        return cmd.timeout !== undefined ? 'callWithTimeout' : 'call';
    }
    return cmd.op;
}

export class LifecycleModel {
    where: Where = 'none';
    state: State = 'idle';
    cfg: ConfigDesc | null = null; // null: never configured (the defaults: strict mode, no html)
    loadedHtml: 'agent' | 'plain' | null = null; // load() since the last setConfig()
    refusal: string | null = null;
    lastDesc: ConfigDesc | null = null;
    lastCopy: string | null = null;
    lastInputs = -1;
    inputs = 0;
    files: Record<string, string> = {};
    gen = 0;
    env: Env | null = null;
    nextEnv = 1;
    pendingTermination: { reason: string; gen: number } | null = null;
    dispatching: string[] = []; // the 'terminated' reasons being dispatched, innermost last
    writes: Map<string, Pending> | null = null; // the current overlay's pending list (kept after a termination)
    writesEnv: Env | null = null;
    announced = new Map<string, number>(); // fileswritten per path, for the overlay
    hostMethods = new Map<string, 'echo' | 'throw'>();
    exposes = 0;
    calls = new Map<number, CallRecord>();
    nextCall = 1;
    mustNotRun = new Set<string>(); // "[env:N] mark id" lines that must never appear (round 5, L-1)
    marksSeen = new Set<string>();
    frames: Frame[] = [];
    coverage = new Set<string>();
    readonly mode: Mode;

    constructor(mode: Mode) {
        this.mode = mode;
    }

    fail(message: string): never {
        throw new Divergence(message);
    }

    // ---- derived values

    get modeNow(): Mode {
        const cfg = this.cfg;
        return cfg && cfg.kind === 'valid' ? cfg.mode : 'strict';
    }

    get scriptUnsafe(): boolean {
        const cfg = this.cfg;
        return !!cfg && cfg.kind === 'valid' && cfg.scriptUnsafe === true;
    }

    private buildRefusal(): string | null {
        if (this.refusal !== null) return this.refusal;
        const cfg = this.cfg;
        if (cfg && cfg.kind === 'unknownMode') return unknownModeReason(cfg.mode);
        if (cfg && cfg.kind === 'valid' && cfg.mode === 'strict' && cfg.entry) {
            if (!(cfg.entry in this.files) || !cfg.entry.endsWith('.js')) return `the guest entry "${cfg.entry}" is not a registered JavaScript file`;
        }
        return null;
    }

    private newEnv(now: number): Env {
        const cfg = this.cfg;
        const valid = cfg && cfg.kind === 'valid' ? cfg : null;
        const mode = valid ? valid.mode : 'strict';
        const html = this.loadedHtml ?? (valid ? valid.html : 'none');
        const entry = valid && mode === 'strict' ? valid.entry : undefined;
        return {
            id: this.nextEnv++,
            mode,
            agent: mode === 'strict' ? entry === AGENT_PATH : mode === 'cooperative' ? html === 'agent' && !valid?.noScripts : false,
            bootstrap: !(mode === 'cooperative' && valid?.noScripts),
            ready: false,
            startedAt: now,
            busy: false,
            execBusy: false,
            entryBad: entry === BAD_ENTRY_PATH,
            guestWrites: !!valid && valid.guestWrites === true,
            tinyBytes: !!valid && valid.limits === 'tinyBytes',
            fewCalls: !!valid && valid.limits === 'fewCalls',
            fetch: !!valid && valid.fetch,
            watchdog: valid ? positiveTimeout(valid.watchdog) : 0,
            execTimeout: valid && mode !== 'cooperative' ? positiveTimeout(valid.execTimeout) : 0,
            built: { ...this.files },
        };
    }

    // ---- the element's internal steps (host.ts: _teardown, initialize, stop, _terminate)

    private teardown() {
        this.gen++;
        this.pendingTermination = null;
        this.env = null;
    }

    private discardWrites() {
        this.writes = null;
        this.writesEnv = null;
        this.announced = new Map();
    }

    private initialize(now: number) {
        const buildWithin = this.dispatching.length ? this.dispatching[this.dispatching.length - 1]! : null;
        this.teardown();
        this.discardWrites();
        if (this.where !== 'own') {
            this.state = 'idle';
            return;
        }
        this.state = 'loading';
        const refusal = this.buildRefusal();
        if (refusal !== null) {
            this.state = 'terminated';
            if (refusal !== buildWithin) this.pendingTermination = { reason: refusal, gen: this.gen };
            return;
        }
        this.env = this.newEnv(now);
        if (this.env.guestWrites) {
            this.writes = new Map();
            this.writesEnv = this.env;
        }
    }

    private stop() {
        this.teardown();
        this.discardWrites();
        this.state = 'idle';
    }

    private terminate(reason: string, frame: Frame | null) {
        if (this.state === 'terminated') return;
        this.teardown(); // the overlay's writes stay listable and committable until the next build
        this.state = 'terminated';
        if (frame) frame.expected.push({ type: 'terminated', reason });
    }

    private configKey(desc: ConfigDesc): string {
        return JSON.stringify(desc);
    }

    // ---- operations: begin() applies the transition before the runner performs it, end() checks what happened

    // An undecided path (interleaved guest requests) takes what listGuestWrites() shows, the truth (API.md, Guest writes);
    // it stays undecided while a request is in flight there, except for a commit, which acts on the list as it is now.
    sync(listed: { path: string; change: string; text?: string }[], force = false) {
        const writes = this.writes;
        if (!writes) return;
        for (const path of [...this.uncertain]) {
            const busy = [...this.calls.values()].some(call => !call.settled && (call.spec.k === 'write' || call.spec.k === 'remove') && (call.spec as { path: string }).path === path);
            if (busy && !force) continue;
            const entry = listed.find(candidate => candidate.path === path);
            if (!entry) writes.delete(path);
            else writes.set(path, entry.change === 'write' ? { change: 'write', text: entry.text ?? '' } : { change: 'remove' });
            if (!busy) this.uncertain.delete(path);
        }
    }

    begin(cmd: Cmd, now: number, seen?: { listed: { path: string; change: string; text?: string }[] }): Frame {
        const frame: Frame = { cmd, expected: [], gen0: this.gen, expectThrow: null, expectWarn: false };
        this.coverage.add(`${opName(cmd)}|${this.state}|${this.mode}`);
        if (cmd.op === 'foreign' || (cmd.op === 'remove' && this.where !== 'none') || cmd.op === 'insert') this.coverage.add(`${opName(cmd)}|where:${this.where}|${this.mode}`);
        this.frames.push(frame);
        switch (cmd.op) {
            case 'insert':
                this.where = 'own';
                this.initialize(now); // a move is disconnected (stop), then connected (a build)
                break;
            case 'remove':
                if (this.where === 'none') break; // remove() of a detached element does nothing
                this.where = 'none';
                this.stop();
                break;
            case 'foreign':
                if (this.where !== 'foreign') frame.expectWarn = false; // warned once per element: not checked
                this.where = 'foreign';
                this.stop();
                break;
            case 'setConfig':
            case 'setConfigEqual': {
                const desc = cmd.op === 'setConfig' ? cmd.cfg : this.lastDesc;
                if (!desc) break; // nothing set yet: the runner skips it too
                this.lastDesc = desc;
                const cloneable = !(desc.kind === 'unusable' && desc.why === 'function');
                const current = this.lastCopy !== null && this.lastInputs === this.inputs && this.refusal === null && (this.state === 'ready' || this.state === 'loading');
                if (cloneable && current && this.configKey(desc) === this.lastCopy) {
                    this.coverage.add(`setConfig-noop|${this.state}|${this.mode}`);
                    break;
                }
                this.inputs++;
                const refused = refusalOf(desc);
                if (refused !== null) {
                    this.refusal = refused;
                    this.lastCopy = null; // the previous config stays
                } else {
                    this.cfg = desc;
                    this.loadedHtml = null;
                    this.refusal = null;
                    this.lastCopy = this.configKey(desc);
                    this.lastInputs = this.inputs;
                }
                this.initialize(now);
                break;
            }
            case 'load':
                this.inputs++;
                this.loadedHtml = cmd.agent ? 'agent' : 'plain';
                this.initialize(now);
                break;
            case 'reset':
                this.initialize(now);
                break;
            case 'terminate': {
                const raw = cmd.reason;
                const reason = typeof raw === 'string' && raw.trim() !== '' ? raw : DEFAULT_TERMINATE_REASON;
                this.terminate(reason, frame);
                break;
            }
            case 'register': {
                const changed = Object.entries(cmd.files).filter(([path, text]) => this.files[path] !== text).map(([path]) => path);
                for (const path of changed) this.files[path] = cmd.files[path]!;
                if (changed.length) {
                    this.inputs++;
                    frame.expected.push({ type: 'fileschanged', paths: changed });
                }
                break;
            }
            case 'registerBad':
                frame.expectThrow = 'INVALID_PATH';
                break;
            case 'unregister': {
                const removed = (cmd.paths ?? Object.keys(this.files)).filter(path => path in this.files);
                for (const path of removed) delete this.files[path];
                if (removed.length) {
                    this.inputs++;
                    frame.expected.push({ type: 'fileschanged', paths: removed });
                }
                break;
            }
            case 'expose':
                this.exposes++;
                this.hostMethods.set('hostEcho', cmd.variant);
                break;
            case 'call':
                this.beginCall(cmd, frame, now);
                break;
            case 'execute': {
                const accepted = cmd.code !== 'nonstring' && this.scriptUnsafe && (this.state === 'loading' || this.state === 'ready');
                frame.executed = { accepted, id: this.nextCall++ };
                frame.expectWarn = !accepted;
                if (accepted && this.env) {
                    if (cmd.code === 'agent') this.env.agent = this.env.bootstrap;
                    if (cmd.code === 'busy') this.env.execBusy = this.env.busy = true;
                }
                break;
            }
            case 'commit':
                if (seen) this.sync(seen.listed, true);
                this.beginCommit(cmd, frame);
                break;
            case 'listWrites':
            case 'wait':
            case 'settle':
                break;
        }
        return frame;
    }

    private beginCall(cmd: Extract<Cmd, { op: 'call' }>, frame: Frame, now: number) {
        const env = this.env;
        const record: CallRecord = {
            id: this.nextCall++,
            method: cmd.method,
            spec: cmd.spec,
            timeout: callTimeout(cmd.timeout, cmd.timeout !== undefined),
            t0: now,
            gen0: this.gen,
            envId: env?.id ?? null,
            immediate: null,
            agent: !!env?.agent,
            bootstrap: !!env?.bootstrap,
            concurrentPath: false,
            announcedBefore: 0,
            settled: false,
            exposes: this.exposes,
            applied: null,
        };
        frame.callId = record.id;
        if (this.state === 'idle' || this.state === 'terminated') {
            record.immediate = 'TERMINATED';
            frame.getterMustNotRun = true; // refused before its arguments are read
        } else if (cmd.method === 'long') {
            record.immediate = 'INVALID_CALL';
        } else if (cmd.arg === 'function' || cmd.arg === 'error' || cmd.arg === 'getterThrow') {
            record.immediate = 'ARGS_NOT_TRANSFERABLE';
        }
        const spec = cmd.spec;
        if ((spec.k === 'write' || spec.k === 'remove') && record.immediate === null) {
            for (const other of this.calls.values()) {
                if (other.settled || (other.spec.k !== 'write' && other.spec.k !== 'remove') || (other.spec as { path: string }).path !== spec.path) continue;
                other.concurrentPath = record.concurrentPath = true; // their announcements interleave: neither counts its own
            }
            record.announcedBefore = this.announced.get(spec.path) ?? 0;
        }
        if (spec.k === 'busy' && env && record.immediate === null && cmd.method === 'act') env.busy = true;
        this.calls.set(record.id, record);
    }

    private beginCommit(cmd: Extract<Cmd, { op: 'commit' }>, frame: Frame) {
        const writes = this.writes;
        if (!writes) return; // no overlay: nothing to commit, no throw
        const chosen = [...new Set(cmd.paths)].filter(path => writes.has(path));
        if (!cmd.code && chosen.some(path => writes.get(path)!.change === 'write' && !isInertPath(path))) {
            frame.expectThrow = 'FILES_NOT_ALLOWED';
            return;
        }
        const changed: string[] = [];
        for (const path of chosen) {
            const change = writes.get(path)!;
            writes.delete(path);
            if (change.change === 'write') {
                if (this.files[path] !== change.text) changed.push(path);
                this.files[path] = change.text;
            } else if (path in this.files) {
                delete this.files[path];
                changed.push(path);
            }
        }
        if (changed.length) {
            this.inputs++;
            frame.expected.push({ type: 'fileschanged', paths: changed });
        }
    }

    /** After the runner performed the command: what it threw, how many warnings, the element's state. */
    end(frame: Frame, observed: { threw: string | null; warned: number; state: string; listed?: { path: string; change: string; text?: string }[] }) {
        this.frames.pop();
        const cmd = frame.cmd;
        const what = `${cmd.op}`;
        if (frame.expected.length) this.fail(`${what}: expected ${JSON.stringify(frame.expected)} synchronously, not dispatched`);
        if ((observed.threw ?? null) !== frame.expectThrow) this.fail(`${what}: threw ${observed.threw}, expected ${frame.expectThrow}`);
        if (frame.expectWarn && observed.warned < 1) this.fail(`${what}: expected a console warning`);
        if (cmd.op === 'call') {
            const record = this.calls.get(frame.callId!)!;
            if (frame.getterMustNotRun && frame.getterRan) this.fail('call: a getter in the arguments ran while there was no environment');
            // a getter that tore the environment down: the call is TERMINATED (review round 3, L-2)
            if (record.immediate === null && this.gen !== frame.gen0) record.immediate = 'TERMINATED';
        }
        if (observed.state !== this.state) this.fail(`${what}: state ${observed.state}, the model says ${this.state}`);
        if (cmd.op === 'listWrites' && observed.listed) {
            this.sync(observed.listed);
            this.checkListed(observed.listed);
        }
    }

    private checkListed(listed: { path: string; change: string; text?: string }[]) {
        const busy = new Set([...this.calls.values()].filter(call => !call.settled && (call.spec.k === 'write' || call.spec.k === 'remove')).map(call => (call.spec as { path: string }).path));
        const expected = this.writes ?? new Map<string, Pending>();
        const paths = new Set([...expected.keys(), ...listed.map(entry => entry.path)]);
        for (const path of paths) {
            if (busy.has(path) || this.uncertain.has(path)) continue;
            const got = listed.find(entry => entry.path === path);
            const want = expected.get(path);
            const gotKey = got ? `${got.change}:${got.text ?? ''}` : 'none';
            const wantKey = want ? `${want.change}:${want.change === 'write' ? want.text : ''}` : 'none';
            if (gotKey !== wantKey) this.fail(`listGuestWrites(): ${path} is ${gotKey}, the model says ${wantKey}`);
        }
    }

    // paths whose listing the documentation does not decide (a removal of a written path the files hold since a commit)
    uncertain = new Set<string>();

    // ---- observations

    /** An event, seen by the runner's first listener. */
    event(ev: Observation) {
        if (!ev.frozen && ev.detail !== null && ev.detail !== undefined) this.fail(`${ev.type}: its detail is not frozen`);
        const top = this.frames[this.frames.length - 1];
        const expected = top?.expected[0];
        switch (ev.type) {
            case 'ready': {
                if (ev.inDom) this.fail('ready dispatched inside a DOM operation (appendChild/remove)');
                if (ev.depth > 0) this.fail(`ready dispatched synchronously inside ${top?.cmd.op}`);
                if (this.state !== 'loading' || !this.env || this.env.ready) this.fail(`ready while the model is ${this.state}${this.env?.ready ? ' (already ready)' : ''}`);
                if (ev.state !== 'ready') this.fail(`state is ${ev.state} at ready`);
                this.env.ready = true;
                this.state = 'ready';
                this.coverage.add(`event:ready|${this.mode}`);
                return;
            }
            case 'terminated': {
                const reason = ev.detail?.reason;
                if (ev.state !== 'terminated') this.fail(`state is ${ev.state} at terminated`);
                if (expected && expected.type === 'terminated' && ev.depth > 0) {
                    if (reason !== expected.reason) this.fail(`terminated with "${reason}", expected "${expected.reason}"`);
                    top!.expected.shift();
                } else if (ev.depth === 0 && this.pendingTermination && this.pendingTermination.reason === reason && this.state === 'terminated') {
                    this.pendingTermination = null;
                    this.coverage.add(`event:terminated-refusal|${this.mode}`);
                } else if (ev.depth === 0 && this.autonomousAllowed(reason, ev.now)) {
                    this.teardown();
                    this.state = 'terminated';
                    this.coverage.add(`event:terminated-self|${this.mode}`);
                } else {
                    this.fail(`unexpected terminated "${reason}" (model: ${this.state}, pending ${JSON.stringify(this.pendingTermination)}, dispatching ${JSON.stringify(this.dispatching)}, depth ${ev.depth})`);
                }
                this.dispatching.push(reason);
                return;
            }
            case 'fileschanged': {
                if (!expected || expected.type !== 'fileschanged') this.fail(`unexpected fileschanged ${JSON.stringify(ev.detail)}`);
                const got = [...ev.detail.paths].sort().join(',');
                const want = [...expected.paths!].sort().join(',');
                if (got !== want) this.fail(`fileschanged ${got}, expected ${want}`);
                top!.expected.shift();
                return;
            }
            case 'sandbox-log':
                this.logLine(ev);
                return;
            case 'fileswritten': {
                const env = this.env;
                if (!env || !env.guestWrites || (this.state !== 'ready' && this.state !== 'loading')) this.fail(`fileswritten ${JSON.stringify(ev.detail)} with no environment that records writes`);
                if (env.tinyBytes) this.fail('fileswritten under a byte budget below the smallest call: every guest write is ARGS_NOT_TRANSFERABLE');
                const paths: string[] = ev.detail.paths;
                if (paths.length !== 1) this.fail(`fileswritten names ${paths.length} paths`);
                this.announced.set(paths[0]!, (this.announced.get(paths[0]!) ?? 0) + 1);
                this.announce(paths[0]!, env);
                this.coverage.add(`event:fileswritten|${this.mode}`);
                return;
            }
            case 'fetch': {
                const url: string = ev.detail?.url ?? '';
                const match = /[?&]env=(\d+)/.exec(url);
                if (ev.detail?.outcome === 'aborted') return;
                if (!this.env || !match || Number(match[1]) !== this.env.id) this.fail(`fetch record ${url} (${ev.detail?.outcome}) does not belong to the current environment ${this.env?.id}`);
                this.coverage.add(`event:fetch|${this.mode}`);
                return;
            }
        }
    }

    /** After the last listener of an event (the runner's closing listener). */
    eventEnd(type: string) {
        if (type === 'terminated') this.dispatching.pop();
    }

    private autonomousAllowed(reason: string, now: number): boolean {
        const env = this.env;
        if (!env || (this.state !== 'loading' && this.state !== 'ready')) return false;
        if (reason === WATCHDOG_REASON) return env.watchdog > 0 && env.busy;
        if (reason === EXECUTION_TIMEOUT_REASON) return env.execTimeout > 0 && env.execBusy;
        if (reason === ENTRY_FAILED_REASON) return env.entryBad;
        if (LOAD_TIMEOUT_REASONS.includes(reason)) return this.state === 'loading' && now - env.startedAt >= LOAD_TIMEOUT_MS - 100;
        return false;
    }

    private logLine(ev: Observation) {
        const detail = ev.detail;
        const text = (detail.args as unknown[]).map(String).join(' ');
        if (detail.source === 'host') {
            const env = this.env;
            if (/^\[Sandbox\] the guest logged more than \d+ lines in one second/.test(text)) return;
            if (text === 'Execution Timeout' && env && env.execTimeout > 0 && env.execBusy) return;
            if (text.startsWith('[Sandbox] the guest entry failed to start') && env?.entryBad) return;
            // The view's first overrun (backlog S72): wall time, so a loaded machine can reach it with the generator's
            // small views; it changes no state, and is allowed in any standing strict environment. The second, which
            // ends the sandbox, stays a divergence (autonomousAllowed).
            if (/^\[Sandbox\] the view spent more than \d+ ms on one operation; a second such operation within \d+ minutes ends the sandbox\.$/.test(text) && env && this.mode === 'strict' && (this.state === 'loading' || this.state === 'ready')) return;
            this.fail(`host line not allowed here: ${text.slice(0, 200)}`);
        }
        if (!this.env || (this.state !== 'loading' && this.state !== 'ready')) this.fail(`guest line with no standing environment: ${text.slice(0, 200)}`);
        const tag = /^\[env:(\d+)\] (mark|exec) (\d+)/.exec(text);
        const any = /^\[env:(\d+)\]/.exec(text);
        if (any && Number(any[1]) !== this.env.id) this.fail(`a line of environment ${any[1]} reached environment ${this.env.id}: ${text.slice(0, 120)}`);
        if (tag) {
            const key = `${tag[1]}:${tag[3]}`;
            if (this.mustNotRun.has(key)) this.fail(`call ${tag[3]} timed out before ready and ran anyway (review round 5, L-1)`);
            this.marksSeen.add(key);
        }
        this.coverage.add(`event:sandbox-log|${this.mode}`);
    }

    /** A call's promise settled (observed in its reaction). */
    settled(id: number, outcome: Settlement, now: number) {
        const record = this.calls.get(id);
        if (!record) this.fail(`settlement of unknown call ${id}`);
        if (record.settled) this.fail(`call ${id} settled twice`);
        record.settled = true;
        const code = outcome.status === 'rejected' ? String(outcome.code) : 'resolved';
        const where = `call ${id} (${record.method} ${JSON.stringify(record.spec)})`;
        if (record.immediate !== null) {
            if (code !== record.immediate) this.fail(`${where}: ${code}, expected ${record.immediate}`);
            return;
        }
        const torn = this.gen !== record.gen0;
        if (code === 'TERMINATED') {
            if (!torn) this.fail(`${where}: TERMINATED with its environment still standing`);
            return;
        }
        if (code === 'TIMEOUT') {
            if (now - record.t0 < record.timeout - 2) this.fail(`${where}: TIMEOUT after ${Math.round(now - record.t0)} ms, its timeout is ${record.timeout}`);
            const env = this.env;
            if (record.method === 'act' && record.spec.k === 'mark' && env && env.id === record.envId && !env.ready) this.mustNotRun.add(`${record.envId}:${id}`);
            return;
        }
        if (record.method === 'missing') {
            if (code !== 'UNKNOWN_METHOD') this.fail(`${where}: ${code}, expected UNKNOWN_METHOD`);
            return;
        }
        if (!record.bootstrap) this.fail(`${where}: ${code} from a guest with no bootstrap (only TIMEOUT or TERMINATED)`);
        if (code === 'UNKNOWN_METHOD') {
            if (record.agent) this.fail(`${where}: UNKNOWN_METHOD, but the agent was installed before the call`);
            return;
        }
        if (code === 'HANDLER_ERROR') {
            if (record.spec.k !== 'throw') this.fail(`${where}: HANDLER_ERROR`);
            return;
        }
        if (code !== 'resolved') this.fail(`${where}: ${code}`);
        if (record.spec.k === 'throw') this.fail(`${where}: resolved, the guest's handler throws`);
        this.checkResult(record, outcome.value, where);
    }

    private envOf(record: CallRecord): Env | null {
        if (this.env && this.env.id === record.envId) return this.env;
        if (this.writesEnv && this.writesEnv.id === record.envId) return this.writesEnv;
        return null;
    }

    private checkResult(record: CallRecord, value: unknown, where: string) {
        const env = this.envOf(record);
        const spec = record.spec;
        if (spec.k === 'mark' && value !== record.id) this.fail(`${where}: answered ${JSON.stringify(value)}`);
        if (!env) return;
        if (spec.k === 'callHost') {
            const allowed = env.tinyBytes
                ? ['code:ARGS_NOT_TRANSFERABLE']
                : [...(env.fewCalls ? ['code:BUSY'] : []), this.hostMethods.get('hostEcho') === 'echo' ? `echo:${env.id}` : this.hostMethods.get('hostEcho') === 'throw' ? 'code:HANDLER_ERROR' : 'code:UNKNOWN_METHOD'];
            // a host method exposed again while the call was in flight: either handler may answer
            const reexposed = this.exposes !== record.exposes && (String(value).startsWith('echo:') || String(value) === 'code:HANDLER_ERROR');
            if (!allowed.includes(String(value)) && !reexposed) this.fail(`${where}: the guest's call to the host got ${String(value)}, expected one of ${allowed}`);
            if (env.tinyBytes && value !== 'code:ARGS_NOT_TRANSFERABLE') this.fail(`${where}: a guest call under a byte budget below one call got ${String(value)}, expected ARGS_NOT_TRANSFERABLE`);
            this.coverage.add(`guest-call:${String(value).split(':')[0] === 'code' ? String(value) : 'ok'}|${this.mode}`);
        }
        if (spec.k === 'write' || spec.k === 'remove') this.checkWrite(record, env, String(value), where);
    }

    // What a guest write or removal changes in the pending list, as the documentation says: `delta` is 1 when what
    // listGuestWrites() shows at the path changes (one fileswritten), 0 when nothing listed changes; 'notFound' when the
    // guest's own files do not hold the path (sandboxFiles answers NOT_FOUND itself); 'uncertain' when it is not documented.
    private classify(spec: { k: 'write' | 'remove'; path: string; text?: string }, env: Env, writes: Map<string, Pending>): { delta: 0 | 1 | 'notFound' | 'uncertain'; next: Pending | null } {
        const before = writes.get(spec.path);
        if (spec.k === 'write') return { delta: before && before.change === 'write' && before.text === spec.text ? 0 : 1, next: { change: 'write', text: spec.text! } };
        const guestHas = before ? before.change === 'write' : spec.path in env.built;
        if (!guestHas) return { delta: 'notFound', next: before ?? null };
        if (before && before.change === 'write') {
            if (spec.path in this.files) return { delta: 'uncertain', next: null }; // written, and the files hold it since a commit
            return { delta: 1, next: null }; // a withdrawn write: announced, nothing listed
        }
        if (spec.path in this.files) return { delta: 1, next: { change: 'remove' } };
        return { delta: 0, next: null }; // a file the host unregistered since the build: listed nowhere, announced nowhere
    }

    private apply(path: string, next: Pending | null, writes: Map<string, Pending>) {
        if (next) writes.set(path, next);
        else writes.delete(path);
    }

    // A fileswritten: the element records a change before it announces it, and the guest's answer comes after, so the
    // change is the one of the write in flight at that path (a listener may end the environment before any answer).
    private announce(path: string, env: Env) {
        const writes = this.writes;
        const inFlight = [...this.calls.values()].filter(call => !call.settled && call.envId === env.id && (call.spec.k === 'write' || call.spec.k === 'remove') && (call.spec as { path: string }).path === path);
        if (inFlight.length === 0) this.fail(`fileswritten for ${path} with no guest write in flight there`);
        if (!writes || this.writesEnv !== env) return;
        if (inFlight.length > 1 || this.uncertain.has(path)) {
            // interleaved requests at one path: which one this announces is not observable, and the guest checks a removal
            // against its own view, which changes only when the element's answer arrives (API.md, Guest writes)
            for (const call of inFlight) if (call.applied === null) call.applied = 'uncertain';
            this.uncertain.add(path);
            return;
        }
        const call = inFlight[0]!;
        if (call.applied !== null) this.fail(`a second fileswritten for ${path} for one request (${JSON.stringify(call.spec)})`);
        const { delta, next } = this.classify(call.spec as { k: 'write' | 'remove'; path: string; text?: string }, env, writes);
        if (delta === 0 || delta === 'notFound') this.fail(`fileswritten for ${path}, but ${JSON.stringify(call.spec)} changes nothing listed (${delta})`);
        if (delta === 'uncertain') this.uncertain.add(path);
        this.apply(path, next, writes);
        call.applied = delta;
        this.coverage.add(`write:${call.spec.k}-announced|${this.mode}`);
    }

    private checkWrite(record: CallRecord, env: Env, value: string, where: string) {
        const spec = record.spec as { k: 'write' | 'remove'; path: string; text?: string };
        if (!env.guestWrites) {
            if (value !== 'code:FILES_NOT_ALLOWED' && !(spec.k === 'remove' && value === 'code:NOT_FOUND')) this.fail(`${where}: ${value} with guestWrites off, expected FILES_NOT_ALLOWED`);
            return;
        }
        if (env.tinyBytes) {
            if (value !== 'code:ARGS_NOT_TRANSFERABLE' && value !== 'code:NOT_FOUND') this.fail(`${where}: ${value} under a byte budget below one call, expected ARGS_NOT_TRANSFERABLE`);
            return;
        }
        if (record.concurrentPath || record.applied === 'uncertain') {
            const allowed = ['ok', 'code:NOT_FOUND', ...(env.fewCalls ? ['code:BUSY', 'code:FILES_BUSY'] : [])];
            if (!allowed.includes(value)) this.fail(`${where}: ${value}`);
            this.uncertain.add(spec.path);
            return;
        }
        if (record.applied !== null) {
            if (value !== 'ok') this.fail(`${where}: ${value}, after its change was announced`);
            return;
        }
        if (value === 'code:BUSY' || value === 'code:FILES_BUSY') {
            if (!env.fewCalls) this.fail(`${where}: ${value} within the budget`);
            return;
        }
        const writes = this.writes;
        if (!writes || this.writesEnv !== env || this.uncertain.has(spec.path)) return;
        const { delta, next } = this.classify(spec, env, writes);
        if (delta === 'notFound') {
            if (value !== 'code:NOT_FOUND') this.fail(`${where}: ${value}, expected NOT_FOUND (the guest's files do not hold it)`);
            return;
        }
        if (value !== 'ok') this.fail(`${where}: ${value}`);
        if (delta === 1 && !record.concurrentPath) this.fail(`${where}: a change of what listGuestWrites() shows at ${spec.path} was never announced`);
        if (delta === 'uncertain') this.uncertain.add(spec.path);
        this.apply(spec.path, next, writes);
        this.coverage.add(`write:${spec.k}-unannounced|${this.mode}`);
    }

    /** The end of a sequence, after the element was removed and every call had time to settle. */
    finish() {
        const open = [...this.calls.values()].filter(call => !call.settled);
        if (open.length) this.fail(`${open.length} call(s) never settled: ${open.map(call => call.id).join(', ')}`);
    }

    /** Whether nothing more is owed: no build loading, no build termination still to come. */
    get quiet(): boolean {
        return this.state !== 'loading' && this.pendingTermination === null;
    }
}
