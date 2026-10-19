/**
 * The seeded command generator for the lifecycle model (test/model/lifecycle-model.ts) and the shrinker: pure, no DOM.
 * fast-check is not a dependency, so the random source is mulberry32 and shrinking is delta debugging (ddmin) over the
 * command list, then over the listener plans.
 */
import type { Cmd, ConfigDesc, GuestSpec, Mode, Plan, PlanEvent, Raw, Sequence } from './lifecycle-model';

/** mulberry32: a 32-bit seeded PRNG; the same seed gives the same sequence on every engine. */
export function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

export class Rng {
    readonly next: () => number;
    constructor(seed: number) {
        this.next = mulberry32(seed);
    }
    int(lo: number, hi: number): number {
        return lo + Math.floor(this.next() * (hi - lo + 1));
    }
    pick<T>(items: readonly T[]): T {
        return items[Math.floor(this.next() * items.length)]!;
    }
    chance(p: number): boolean {
        return this.next() < p;
    }
}

const MODES: Mode[] = ['strict', 'cooperative', 'worker'];
const TIMEOUT_VALUES: Raw[] = [0, -1, 'NaN', 'Infinity', 2 ** 31 + 5, 2 ** 32, 1e12, 5, 20, 60, 150, 400];
// The watchdog of an ordinary config, in a calm segment: off in every spelling, or on with a budget no responsive guest
// misses (S65 PR D). The model allows the watchdog's termination only once a guest step blocked the event loop (`busy`,
// lifecycle-model.ts, autonomousAllowed); scenario 3 below pairs a 150 ms watchdog with such a step. These were 150 and
// 250 ms, and at a load average of 15 to 19 a strict guest's worker, starved for longer than that, missed its pings with
// nothing busy: WebKit seed 225 diverged at 500 sequences, at the PR B commit as at PR C's (2 and 1 in 16 runs of its
// repro). The fix is here, not in the model: a model that accepted a watchdog termination for any short budget would no
// longer catch a watchdog that fires on a guest that answers (pings on the wrong port, a pong not heard), which is what
// the rule is for. 4000 and 5000 ms keep the watchdog armed and pinging through the calm segments, at the budget the
// element itself deems safe against scheduling jitter: its always-on view liveness check (VIEW_LIVENESS_TIMEOUT_MS,
// 5000). The array keeps its length, so every seed draws the same values elsewhere.
const WATCHDOG_VALUES: (Raw | undefined)[] = [undefined, undefined, 0, -1, 'NaN', 'Infinity', '300', 5000, 4000];
const EXEC_VALUES: (Raw | undefined)[] = [undefined, undefined, 0, 'NaN', 150, 300];
const SWITCHES: Raw[] = [true, true, true, 'true', 1, 0, null, 'no', false];
const WRITE_PATHS = ['w/a.txt', 'w/b.js', 'data.txt'];

/** A config of the sequence's mode, mostly valid. */
export function genConfig(rng: Rng, mode: Mode, variant: number): ConfigDesc {
    const roll = rng.next();
    if (roll < 0.06) return { kind: 'unknownMode', mode: rng.pick(['iframe', 'Strict', 7]) };
    if (roll < 0.12) return { kind: 'unusable', why: rng.pick(['function', 'notObject', 'origins', 'originsList'] as const) };
    const desc: ConfigDesc = {
        kind: 'valid',
        mode,
        // worker mode installs its agent with execute(): scriptUnsafe on, mostly
        scriptUnsafe: mode === 'worker' ? (rng.chance(0.9) ? true : rng.pick(SWITCHES)) : rng.pick(SWITCHES),
        guestWrites: rng.chance(0.6) ? true : rng.pick(SWITCHES),
        watchdog: rng.pick(WATCHDOG_VALUES),
        execTimeout: rng.pick(EXEC_VALUES),
        html: rng.chance(0.8) ? 'agent' : rng.pick(['plain', 'none'] as const),
        fetch: rng.chance(0.4),
        limits: rng.chance(0.75) ? 'none' : rng.pick(['tinyBytes', 'fewCalls', 'bogus'] as const),
        variant,
    };
    if (mode === 'strict') {
        const entry = rng.chance(0.85) ? 'agent.js' : rng.pick(['bad.js', 'missing.js', undefined] as const);
        if (entry) desc.entry = entry;
    }
    if (mode === 'cooperative' && rng.chance(0.08)) desc.noScripts = true;
    return desc;
}

export function genGuestSpec(rng: Rng): GuestSpec {
    const roll = rng.int(0, 15);
    switch (roll) {
        case 0: return { k: 'log', n: rng.int(1, 5) };
        case 1: return { k: 'throw' };
        case 2: return { k: 'uncaught' };
        case 3: return { k: 'busy', ms: rng.int(50, 400) };
        case 4: return { k: 'wait', ms: rng.int(0, 60) };
        case 5: case 6: return { k: 'write', path: rng.pick(WRITE_PATHS), text: rng.pick(['v1', 'v2']) };
        case 7: return { k: 'remove', path: rng.pick(WRITE_PATHS) };
        case 8: return { k: 'fetch' };
        case 9: return { k: 'bgfetch' };
        case 10: case 11: return { k: 'callHost' };
        case 12: return { k: 'expose' };
        default: return { k: 'mark' };
    }
}

/** A lifecycle action, for listener plans and argument getters. */
export function genAction(rng: Rng, mode: Mode, variant: () => number): Cmd {
    const roll = rng.int(0, 11);
    switch (roll) {
        case 0: case 1: return { op: 'reset' };
        case 2: return { op: 'terminate', reason: rng.pick(['from a listener', '', undefined]) };
        case 3: return { op: 'remove' };
        case 4: return { op: 'insert' };
        case 5: return { op: 'foreign' };
        case 6: return { op: 'setConfig', cfg: genConfig(rng, mode, variant()) };
        case 7: return { op: 'setConfigEqual' };
        case 8: return { op: 'load', agent: rng.chance(0.7) };
        case 9: return { op: 'register', files: { 'data.txt': rng.pick(['data', 'data2']) } };
        case 10: return { op: 'call', method: 'act', spec: { k: 'mark' }, timeout: rng.pick([undefined, 20]) };
        default: return { op: 'unregister', paths: [rng.pick(['agent.js', 'data.txt'])] };
    }
}

// Every operation about equally often, so each is reached in every state.
const CMD_KINDS = ['insert', 'remove', 'foreign', 'setConfig', 'setConfig', 'setConfigEqual', 'load', 'reset', 'reset', 'terminate', 'register', 'registerBad', 'unregister', 'expose', 'call', 'call', 'callWithTimeout', 'guest', 'guest', 'guest', 'execute', 'listWrites', 'commit', 'wait', 'settle'] as const;

function genCmd(rng: Rng, mode: Mode, variant: () => number): Cmd {
    switch (rng.pick(CMD_KINDS)) {
        case 'insert': return { op: 'insert' };
        case 'remove': return { op: 'remove' };
        case 'foreign': return { op: 'foreign' };
        case 'setConfig': return { op: 'setConfig', cfg: genConfig(rng, mode, variant()) };
        case 'setConfigEqual': return { op: 'setConfigEqual' };
        case 'load': return { op: 'load', agent: rng.chance(0.75) };
        case 'reset': return { op: 'reset' };
        case 'terminate': return { op: 'terminate', reason: rng.pick(['bye', '', '  ', 7, undefined]) };
        case 'register': return { op: 'register', files: rng.pick<Record<string, string>>([{ 'data.txt': 'data2' }, { 'data.txt': 'data' }, { 'agent.js': 'AGENT' }, { 'x.css': 'p{}' }]) };
        case 'registerBad': return { op: 'registerBad' };
        case 'unregister': return { op: 'unregister', paths: rng.chance(0.15) ? undefined : [rng.pick(['data.txt', 'agent.js', 'x.css', 'nothing.txt'])] };
        case 'expose': return { op: 'expose', variant: rng.chance(0.8) ? 'echo' : 'throw' };
        case 'call':
        case 'callWithTimeout': {
            const method = rng.chance(0.92) ? 'act' : rng.pick(['missing', 'long'] as const);
            // which of a long name and an unsendable argument is refused first is not documented: never both
            const arg = method === 'long' || rng.chance(0.8) ? 'plain' : rng.pick(['function', 'error', 'getterThrow', 'getter'] as const);
            const cmd: Cmd = { op: 'call', method, spec: { k: 'mark' }, arg };
            if (rng.chance(0.5)) cmd.timeout = rng.pick(TIMEOUT_VALUES);
            if (arg === 'getter') cmd.getter = genAction(rng, mode, variant);
            return cmd;
        }
        case 'guest': return { op: 'call', method: 'act', spec: genGuestSpec(rng), ...(rng.chance(0.2) ? { timeout: rng.pick(TIMEOUT_VALUES) } : {}) };
        case 'execute': return { op: 'execute', code: rng.pick(['agent', 'agent', 'mark', 'busy', 'nonstring'] as const) };
        case 'listWrites': return { op: 'listWrites' };
        case 'commit': return { op: 'commit', paths: [rng.pick(WRITE_PATHS), ...(rng.chance(0.3) ? [rng.pick(WRITE_PATHS)] : [])], code: rng.chance(0.5) };
        case 'wait': return { op: 'wait', ms: rng.int(0, 120) };
        default: return { op: 'settle' };
    }
}

/**
 * One sequence: a mode, 0–3 re-entrant listener plans, a prologue (the agent registered, a config, insertion, settle),
 * then 3–6 segments: churn (3–7 operations with no gaps), calm (settle, then guest steps and calls with waits) or a
 * scenario (a call with an argument getter, many calls while loading, the moves of round 4's L-1).
 */
export function generate(seed: number): Sequence {
    const rng = new Rng(seed);
    const mode = MODES[seed % 3]!;
    let counter = 0;
    const variant = () => counter++;
    const plans: Plan[] = [];
    const planCount = rng.chance(0.5) ? 0 : rng.int(1, 3);
    for (let i = 0; i < planCount; i++) {
        plans.push({ event: rng.pick(['ready', 'terminated', 'sandbox-log', 'fileswritten', 'fetch'] as PlanEvent[]), action: genAction(rng, mode, variant), times: rng.int(1, 2) });
    }
    const first = genConfig(rng, mode, variant());
    const cmds: Cmd[] = [
        { op: 'register', files: { 'agent.js': 'AGENT', 'bad.js': 'BAD', 'data.txt': 'data' } },
        { op: 'setConfig', cfg: first },
        { op: 'insert' },
    ];
    if (mode === 'worker') cmds.push({ op: 'execute', code: 'agent' });
    cmds.push({ op: 'expose', variant: 'echo' }, { op: 'settle' });
    const segments = rng.int(3, 6);
    for (let s = 0; s < segments; s++) {
        const kind = rng.pick(['churn', 'churn', 'calm', 'calm', 'scenario'] as const);
        if (kind === 'churn') {
            const n = rng.int(3, 7);
            for (let i = 0; i < n; i++) cmds.push(genCmd(rng, mode, variant));
        } else if (kind === 'calm') {
            cmds.push({ op: 'settle' });
            if (mode === 'worker') cmds.push({ op: 'execute', code: 'agent' });
            const n = rng.int(3, 8);
            for (let i = 0; i < n; i++) {
                cmds.push({ op: 'call', method: 'act', spec: genGuestSpec(rng) });
                if (rng.chance(0.5)) cmds.push({ op: 'wait', ms: rng.int(5, 80) });
            }
            cmds.push({ op: 'wait', ms: 100 }, { op: 'listWrites' });
        } else {
            const scenario = rng.int(0, 4);
            if (scenario === 0) {
                cmds.push({ op: 'settle' }, { op: 'call', method: 'act', spec: { k: 'mark' }, arg: 'getter', getter: genAction(rng, mode, variant) });
            } else if (scenario === 1) {
                // calls made while loading, with timeouts around the check-in (review round 5, L-1)
                cmds.push({ op: 'reset' });
                for (const timeout of [5, 20, 40, 80, 160]) cmds.push({ op: 'call', method: 'act', spec: { k: 'mark' }, timeout });
                cmds.push({ op: 'settle' }, { op: 'wait', ms: 200 });
            } else if (scenario === 2) {
                // round 4's L-1: a move or removal soon after a rebuild
                cmds.push({ op: 'settle' }, { op: 'insert' }, { op: 'wait', ms: rng.int(12, 30) }, rng.pick([{ op: 'insert' }, { op: 'remove' }, { op: 'foreign' }] as Cmd[]), { op: 'insert' });
            } else if (scenario === 3) {
                // a termination the element starts: the watchdog, workerExecutionTimeout or a failing entry
                const which = rng.int(0, 2);
                const base = genConfig(new Rng(seed * 31 + s), mode, variant());
                const valid: ConfigDesc = base.kind === 'valid' ? base : { kind: 'valid', mode, scriptUnsafe: true, guestWrites: false, watchdog: undefined, execTimeout: undefined, html: 'agent', fetch: false, limits: 'none', variant: variant() };
                if (valid.kind !== 'valid') throw new Error('unreachable');
                valid.scriptUnsafe = true;
                if (which === 0) valid.watchdog = 150;
                if (which === 1) valid.execTimeout = 150;
                if (which === 2 && mode === 'strict') valid.entry = 'bad.js';
                if (mode === 'strict' && which !== 2) valid.entry = 'agent.js';
                if (mode === 'cooperative') valid.html = 'agent';
                cmds.push({ op: 'register', files: { 'agent.js': 'AGENT', 'bad.js': 'BAD' } }, { op: 'setConfig', cfg: valid }, { op: 'settle' });
                if (mode === 'worker') cmds.push({ op: 'execute', code: 'agent' });
                cmds.push(which === 1 ? { op: 'execute', code: 'busy' } : { op: 'call', method: 'act', spec: { k: 'busy', ms: 900 } }, { op: 'wait', ms: 1500 }, { op: 'settle' });
            } else {
                // guest writes, listed and committed
                cmds.push({ op: 'settle' });
                if (mode === 'worker') cmds.push({ op: 'execute', code: 'agent' });
                for (let i = 0; i < 3; i++) cmds.push({ op: 'call', method: 'act', spec: genGuestSpec(rng) });
                cmds.push({ op: 'call', method: 'act', spec: { k: 'write', path: rng.pick(WRITE_PATHS), text: 'v1' } }, { op: 'wait', ms: 80 }, { op: 'listWrites' }, { op: 'commit', paths: WRITE_PATHS.slice(), code: rng.chance(0.5) });
            }
        }
    }
    return { seed, mode, plans, cmds };
}

/**
 * Delta debugging (ddmin) of a failing sequence: removes chunks of commands, then plans, while `fails` still says the
 * smaller sequence diverges. `fails` runs the real element, so it is async; `budget` bounds the attempts.
 */
export async function shrink(sequence: Sequence, fails: (candidate: Sequence) => Promise<boolean>, budget = 60): Promise<Sequence> {
    let current = sequence;
    let attempts = 0;
    const tryIt = async (candidate: Sequence) => {
        if (attempts >= budget) return false;
        attempts++;
        return fails(candidate);
    };
    let n = 2;
    while (current.cmds.length >= 2 && attempts < budget) {
        const size = Math.ceil(current.cmds.length / n);
        let reduced = false;
        for (let start = 0; start < current.cmds.length; start += size) {
            const complement = [...current.cmds.slice(0, start), ...current.cmds.slice(start + size)];
            if (complement.length && (await tryIt({ ...current, cmds: complement }))) {
                current = { ...current, cmds: complement };
                n = Math.max(n - 1, 2);
                reduced = true;
                break;
            }
        }
        if (!reduced) {
            if (n >= current.cmds.length) break;
            n = Math.min(n * 2, current.cmds.length);
        }
    }
    for (let i = current.plans.length - 1; i >= 0 && attempts < budget; i--) {
        const plans = current.plans.filter((_, index) => index !== i);
        if (await tryIt({ ...current, plans })) current = { ...current, plans };
    }
    return current;
}
