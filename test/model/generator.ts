/**
 * The seeded command generator for the lifecycle model (test/model/lifecycle-model.ts) and the shrinker: pure, no DOM.
 * fast-check is not a dependency, so the random source is mulberry32 and shrinking is delta debugging (ddmin) over the
 * command list, then over the listener plans.
 */
import { AGENT_PATH, AGENT_TEXT, ENTRY_TEXTS, type Cmd, type ConfigDesc, type GuestSpec, type Mode, type Plan, type PlanEvent, type Raw, type Sequence } from './lifecycle-model';

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
// misses (S65). The model allows the watchdog's termination only once a guest step blocked the event loop (`busy`,
// lifecycle-model.ts, autonomousAllowed); scenario 3 below pairs a 150 ms watchdog with such a step. A budget of 150 or
// 250 ms would not do: at a load average of 15 to 19 a strict guest's worker, starved for longer than that, misses its
// pings with nothing busy, and the model diverges (WebKit seed 225 at 500 sequences). The remedy is here, not in the
// model: a model that accepted a watchdog termination for any short budget would not catch a watchdog that fires on a guest that
// answers (pings on the wrong port, a pong not heard), which is what the rule is for. 4000 and 5000 ms keep the watchdog armed and pinging through the calm segments, at the budget the
// element itself deems safe against scheduling jitter: its always-on view liveness check (VIEW_LIVENESS_TIMEOUT_MS,
// 5000). The array keeps its length, so every seed draws the same values elsewhere.
const WATCHDOG_VALUES: (Raw | undefined)[] = [undefined, undefined, 0, -1, 'NaN', 'Infinity', '300', 5000, 4000];
const EXEC_VALUES: (Raw | undefined)[] = [undefined, undefined, 0, 'NaN', 150, 300];
const SWITCHES: Raw[] = [true, true, true, 'true', 1, 0, null, 'no', false];
// The paths the guest writes and removes: the agent's file, which is the strict app's entry, among them, so a committed
// change can leave the next build with no entry, or with one that calls import() (API.md, `entry`).
const WRITE_PATHS = [AGENT_PATH, 'w/a.txt', 'w/b.js', 'data.txt'];
// The values start() takes, of each option the generator varies: a start() that throws binds nothing, so most configs
// draw from these (`usable`), and the rest from every value, which start() mostly refuses (startRefused).
const USABLE_WATCHDOG = WATCHDOG_VALUES.filter(value => value === undefined || value === 0 || (typeof value === 'number' && value > 0));
const USABLE_EXEC = EXEC_VALUES.filter(value => value === undefined || typeof value === 'number');
const USABLE_SWITCHES = SWITCHES.filter(value => typeof value === 'boolean');

/** A config of the sequence's mode: mostly one start() takes; else one of unusable values, kinds or entries. */
export function genConfig(rng: Rng, mode: Mode, variant: number): ConfigDesc {
    const roll = rng.next();
    if (roll < 0.04) return { kind: 'unknownMode', mode: rng.pick(['iframe', 'Strict', 7]) };
    if (roll < 0.08) return { kind: 'unusable', why: rng.pick(['function', 'notObject', 'origins', 'originsList'] as const) };
    const usable = roll < 0.88;
    const switches = usable ? USABLE_SWITCHES : SWITCHES;
    const desc: ConfigDesc = {
        kind: 'valid',
        mode,
        // worker mode installs its agent with execute(): scriptUnsafe on, mostly
        scriptUnsafe: mode === 'worker' ? (rng.chance(0.9) ? true : rng.pick(switches)) : rng.pick(switches),
        guestWrites: rng.chance(0.6) ? true : rng.pick(switches),
        watchdog: rng.pick(usable ? USABLE_WATCHDOG : WATCHDOG_VALUES),
        execTimeout: rng.pick(usable ? USABLE_EXEC : EXEC_VALUES),
        html: rng.chance(0.8) ? 'agent' : rng.pick(['plain', 'none'] as const),
        fetch: rng.chance(0.4),
        limits: rng.chance(0.75) ? 'none' : rng.pick(usable ? (['tinyBytes', 'fewCalls'] as const) : (['tinyBytes', 'fewCalls', 'bogus'] as const)),
        variant,
    };
    if (mode === 'strict') {
        const entry = rng.chance(0.85) ? 'agent.js' : rng.pick(usable ? (['bad.js', 'import.js', undefined] as const) : (['bad.js', 'import.js', 'missing.js', undefined] as const));
        if (entry) desc.entry = entry;
    }
    if (mode === 'cooperative' && rng.chance(0.08)) desc.noScripts = true;
    return desc;
}

/**
 * An app that ends itself once its guest is busy (`which`): the watchdog at 150 ms, workerExecutionTimeout at 150 ms, or
 * in strict mode an entry that throws. The model allows the watchdog's termination only once a guest step blocked the
 * event loop (lifecycle-model.ts, autonomousAllowed), so the sequence makes it busy right after its prologue.
 */
function endingConfig(mode: Mode, which: number, variant: number): ConfigDesc {
    const desc: ConfigDesc = { kind: 'valid', mode, scriptUnsafe: true, guestWrites: false, watchdog: which === 0 ? 150 : undefined, execTimeout: which === 1 ? 150 : undefined, html: 'agent', fetch: false, limits: 'none', variant };
    if (mode === 'strict') desc.entry = which === 2 ? 'bad.js' : 'agent.js';
    return desc;
}

/** A guest write at `path`: over the entry, one of the entry texts (ENTRY_TEXTS); anywhere else, a plain one. */
function genWrite(rng: Rng, path: string): GuestSpec {
    return { k: 'write', path, text: path === AGENT_PATH ? rng.pick(ENTRY_TEXTS) : rng.pick(['v1', 'v2']) };
}

export function genGuestSpec(rng: Rng): GuestSpec {
    const roll = rng.int(0, 15);
    switch (roll) {
        case 0: return { k: 'log', n: rng.int(1, 5) };
        case 1: return { k: 'throw' };
        case 2: return { k: 'uncaught' };
        case 3: return { k: 'busy', ms: rng.int(50, 400) };
        case 4: return { k: 'wait', ms: rng.int(0, 60) };
        case 5: case 6: return genWrite(rng, rng.pick(WRITE_PATHS));
        case 7: return { k: 'remove', path: rng.pick(WRITE_PATHS) };
        case 8: return { k: 'fetch' };
        case 9: return { k: 'bgfetch' };
        case 10: case 11: return { k: 'callHost' };
        case 12: return { k: 'expose' };
        default: return { k: 'mark' };
    }
}

/** A start() of a config of the sequence's mode, with the host method `hostEcho` mostly. */
function genStart(rng: Rng, mode: Mode, variant: () => number): Cmd {
    return { op: 'start', cfg: genConfig(rng, mode, variant()), methods: rng.chance(0.8) ? 'echo' : rng.pick(['throw', null] as const) };
}

/** A lifecycle action, for listener plans and argument getters. */
export function genAction(rng: Rng, mode: Mode, variant: () => number): Cmd {
    const roll = rng.int(0, 8);
    switch (roll) {
        case 0: case 1: return { op: 'reset' };
        case 2: return { op: 'terminate', reason: rng.pick(['from a listener', '', undefined]) };
        case 3: return { op: 'remove' };
        case 4: return { op: 'insert' };
        case 5: return { op: 'foreign' };
        case 6: return genStart(rng, mode, variant);
        case 7: return { op: 'call', method: 'act', spec: { k: 'mark' }, timeout: rng.pick([undefined, 20]) };
        default: return { op: 'listWrites' };
    }
}

// Every operation about equally often, so each is reached in every state.
const CMD_KINDS = ['insert', 'remove', 'foreign', 'start', 'reset', 'reset', 'terminate', 'call', 'call', 'callWithTimeout', 'guest', 'guest', 'guest', 'execute', 'listWrites', 'commit', 'wait', 'settle'] as const;

function genCmd(rng: Rng, mode: Mode, variant: () => number): Cmd {
    switch (rng.pick(CMD_KINDS)) {
        case 'insert': return { op: 'insert' };
        case 'remove': return { op: 'remove' };
        case 'foreign': return { op: 'foreign' };
        case 'start': return genStart(rng, mode, variant);
        case 'reset': return { op: 'reset' };
        case 'terminate': return { op: 'terminate', reason: rng.pick(['bye', '', '  ', 7, undefined]) };
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
 * The guest changes its own entry and the embedder commits it, then rebuilds (API.md, `entry`): a committed removal
 * leaves the next build no entry (`entryNotRegistered`), a committed write of the import() text one that calls import()
 * (`entryImport`), and a rebuild of a bound app is refused then, from `ready` or from `terminated`, each time with its
 * `terminated`. Sometimes the guest writes the agent back and that is committed too, before the rebuild: the entry is
 * back, and the next build stands again. Then, sometimes, the element is removed, terminated while detached and inserted:
 * the insertion's build is refused or stands the same way.
 */
function entryRewritten(rng: Rng, mode: Mode): Cmd[] {
    const cmds: Cmd[] = [{ op: 'settle' }];
    if (mode === 'worker') cmds.push({ op: 'execute', code: 'agent' });
    const change: GuestSpec = rng.chance(0.5) ? { k: 'remove', path: AGENT_PATH } : genWrite(rng, AGENT_PATH);
    const commit: Cmd = { op: 'commit', paths: [AGENT_PATH], code: rng.chance(0.85) };
    cmds.push({ op: 'call', method: 'act', spec: change }, { op: 'wait', ms: 80 }, { op: 'listWrites' }, commit);
    if (rng.chance(0.3)) cmds.push({ op: 'call', method: 'act', spec: { k: 'write', path: AGENT_PATH, text: AGENT_TEXT } }, { op: 'wait', ms: 80 }, { op: 'commit', paths: [AGENT_PATH], code: true });
    cmds.push({ op: 'reset' }, { op: 'settle' }, { op: 'reset' }, { op: 'settle' });
    // and the insertion's build: of an element terminate() ended while detached, which is `terminated` when it connects
    if (rng.chance(0.5)) cmds.push({ op: 'remove' }, { op: 'terminate', reason: undefined }, { op: 'insert' }, { op: 'settle' });
    return cmds;
}

/**
 * One sequence: a mode, 0–3 re-entrant listener plans, a prologue (the app started, mostly before insertion; settle),
 * then 3–6 segments: churn (3–7 operations with no gaps), calm (settle, then guest steps and calls with waits) or a
 * scenario (a call with an argument getter, many calls while loading, the moves of R4:L-1, a second start(), guest
 * writes, the entry rewritten by the guest and committed). One sequence in five starts an app that ends itself (the watchdog, workerExecutionTimeout or a failing entry),
 * and its first segment makes the guest busy.
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
    // a termination the element starts: the watchdog, workerExecutionTimeout or a failing entry, from the app's start
    const ending = rng.chance(0.2) ? rng.int(0, 2) : null;
    const first = ending === null ? genConfig(rng, mode, variant()) : endingConfig(mode, ending, variant());
    const start: Cmd = { op: 'start', cfg: first, methods: 'echo' };
    const cmds: Cmd[] = rng.chance(0.8) ? [start, { op: 'insert' }] : [{ op: 'insert' }, { op: 'settle' }, start];
    if (mode === 'worker') cmds.push({ op: 'execute', code: 'agent' });
    cmds.push({ op: 'settle' });
    if (ending !== null) {
        cmds.push(ending === 1 ? { op: 'execute', code: 'busy' } : { op: 'call', method: 'act', spec: { k: 'busy', ms: 900 } }, { op: 'wait', ms: 1500 }, { op: 'settle' });
    }
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
            const scenario = rng.int(0, 5);
            if (scenario === 0) {
                cmds.push({ op: 'settle' }, { op: 'call', method: 'act', spec: { k: 'mark' }, arg: 'getter', getter: genAction(rng, mode, variant) });
            } else if (scenario === 1) {
                // calls made while loading, with timeouts around the check-in (R5:L-1)
                cmds.push({ op: 'reset' });
                for (const timeout of [5, 20, 40, 80, 160]) cmds.push({ op: 'call', method: 'act', spec: { k: 'mark' }, timeout });
                cmds.push({ op: 'settle' }, { op: 'wait', ms: 200 });
            } else if (scenario === 2) {
                // R4:L-1: a move or removal soon after a rebuild
                cmds.push({ op: 'settle' }, { op: 'insert' }, { op: 'wait', ms: rng.int(12, 30) }, rng.pick([{ op: 'insert' }, { op: 'remove' }, { op: 'foreign' }] as Cmd[]), { op: 'insert' });
            } else if (scenario === 3) {
                // another app on the same element: start() throws and changes nothing, and the first app still answers
                cmds.push({ op: 'settle' }, genStart(rng, mode, variant), { op: 'call', method: 'act', spec: { k: 'mark' } }, { op: 'settle' });
            } else if (scenario === 4) {
                // guest writes, listed and committed
                cmds.push({ op: 'settle' });
                if (mode === 'worker') cmds.push({ op: 'execute', code: 'agent' });
                for (let i = 0; i < 3; i++) cmds.push({ op: 'call', method: 'act', spec: genGuestSpec(rng) });
                cmds.push({ op: 'call', method: 'act', spec: { k: 'write', path: rng.pick(WRITE_PATHS), text: 'v1' } }, { op: 'wait', ms: 80 }, { op: 'listWrites' }, { op: 'commit', paths: WRITE_PATHS.slice(), code: rng.chance(0.5) });
            } else {
                cmds.push(...entryRewritten(rng, mode));
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
