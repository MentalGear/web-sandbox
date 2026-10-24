/**
 * Runs one generated sequence (test/model/generator.ts) against a real `<web-sandbox>` in the page and checks every step
 * against the lifecycle model (test/model/lifecycle-model.ts). Loaded into the e2e harness page by
 * test/e2e/lifecycle-model.spec.ts, through the e2e server (`import('/test/model/runner.ts')`).
 *
 * Every event of the element is seen by a first listener (the model's checks), then by the sequence's re-entrant listener
 * plans, then by a closing listener; operations run by a plan or by an argument getter are nested operation frames, so
 * the model knows what ran synchronously inside what.
 */
import { AGENT_PATH, BAD_ENTRY_PATH, FEW_CALLS_BUDGET, LifecycleModel, TINY_BYTES_BUDGET, rawValue, type Cmd, type ConfigDesc, type Sequence } from './lifecycle-model';

/** The guest agent: one method, `act(spec)`, that runs a guest step. Installed as the strict entry, as cooperative markup, or by execute(). */
export const AGENT_SOURCE = `(() => {
    const busy = (ms) => { const end = Date.now() + ms; while (Date.now() < end) {} };
    const code = (e) => 'code:' + (e && e.code);
    bridge.expose('act', async (spec) => {
        const tag = '[env:' + spec.env + ']';
        switch (spec.k) {
            case 'mark': console.log(tag + ' mark ' + spec.id); return spec.id;
            case 'log': for (let i = 0; i < spec.n; i++) console.log(tag + ' log ' + i, { i }); return true;
            case 'throw': throw new Error('the agent throws');
            case 'uncaught': setTimeout(() => { throw new Error(tag + ' uncaught'); }); return true;
            case 'busy': setTimeout(() => busy(spec.ms)); return true;
            case 'wait': await new Promise((resolve) => setTimeout(resolve, spec.ms)); return true;
            case 'write': try { await sandboxFiles.write(spec.path, spec.text); return 'ok'; } catch (e) { return code(e); }
            case 'remove': try { await sandboxFiles.remove(spec.path); return 'ok'; } catch (e) { return code(e); }
            case 'fetch': try { const response = await sandboxFetch(spec.url); return response.status; } catch (e) { return code(e); }
            case 'bgfetch': sandboxFetch(spec.url).catch(() => {}); return true;
            case 'callHost': try { return await bridge.call('hostEcho', spec.env); } catch (e) { return code(e); }
            case 'expose': bridge.expose('late', () => true); return true;
        }
        return null;
    });
})();`;

const BAD_ENTRY_SOURCE = `throw new Error('the entry fails');`;
const COOPERATIVE_AGENT_HTML = `<script>${AGENT_SOURCE}</script><p>agent</p>`;

function fileContent(token: string): string {
    if (token === 'AGENT') return AGENT_SOURCE;
    if (token === 'BAD') return BAD_ENTRY_SOURCE;
    return token;
}

/** The object setConfig() receives for a descriptor: a fresh one each time. */
export function configOf(desc: ConfigDesc, origin: string): unknown {
    if (desc.kind === 'unknownMode') return { mode: desc.mode };
    if (desc.kind === 'unusable') {
        switch (desc.why) {
            case 'function': return { mode: 'strict', html: () => 'not cloneable' };
            case 'notObject': return 7;
            case 'origins': return { mode: 'cooperative', origins: 'https://example.com' };
            case 'originsList': return { mode: 'cooperative', origins: { images: 'https://example.com' } };
        }
    }
    const config: Record<string, unknown> = { mode: desc.mode, scriptUnsafe: rawValue(desc.scriptUnsafe), guestWrites: rawValue(desc.guestWrites) };
    if (desc.watchdog !== undefined) config.watchdogTimeout = rawValue(desc.watchdog);
    if (desc.execTimeout !== undefined) config.workerExecutionTimeout = rawValue(desc.execTimeout);
    if (desc.mode === 'cooperative') {
        config.capabilities = desc.noScripts ? [] : ['allow-scripts'];
        if (desc.html !== 'none') config.html = desc.html === 'agent' ? COOPERATIVE_AGENT_HTML : '<p>plain</p>';
    }
    if (desc.mode === 'strict') {
        if (desc.entry) config.entry = desc.entry;
        if (desc.html !== 'none') config.html = `<p>${desc.html}</p>`;
    }
    // (the harness page sends no Content-Security-Policy, so it says so: without that the bridge's list is dropped)
    if (desc.fetch) {
        config.fetchBridge = { allow: [origin] };
        config.hostContentSecurityPolicy = false;
    }
    // the variant keeps two otherwise equal configs apart, in a field every mode keeps
    const variant = desc.variant;
    config.callLimits =
        desc.limits === 'tinyBytes' ? { maxBytesPerSecond: TINY_BYTES_BUDGET, maxPerSecond: 1000 + variant }
        : desc.limits === 'fewCalls' ? { maxPerSecond: FEW_CALLS_BUDGET, maxBytesPerSecond: 67108864 - variant }
        : desc.limits === 'bogus' ? { maxPerSecond: 'bogus', maxBytesPerSecond: 67108864 - variant }
        : { maxPerSecond: 1000 + variant };
    return config;
}

function deepFrozen(value: unknown, seen = new WeakSet<object>()): boolean {
    if (value === null || typeof value !== 'object') return true;
    if (seen.has(value)) return true;
    seen.add(value);
    if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return true; // bytes cannot be frozen (API.md, Events)
    if (!Object.isFrozen(value)) return false;
    if (value instanceof Map || value instanceof Set || value instanceof Date) return true;
    for (const key of Reflect.ownKeys(value)) {
        const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
        if (descriptor && 'value' in descriptor && !deepFrozen(descriptor.value, seen)) return false;
    }
    return true;
}

function listingOf(entries: any[]): { path: string; change: string; text?: string }[] {
    return entries.map(entry => ({ path: entry.path, change: entry.change, ...(entry.change === 'write' ? { text: new TextDecoder().decode(entry.content) } : {}) }));
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export interface RunResult {
    ok: boolean;
    divergence?: string;
    step?: number;
    coverage: string[];
    events: Record<string, number>;
    trace: string[];
    ms: number;
}

const EVENTS = ['ready', 'terminated', 'sandbox-log', 'fileswritten', 'fetch', 'fileschanged'] as const;

export async function runSequence(sequence: Sequence, origin = location.origin): Promise<RunResult> {
    const started = performance.now();
    const model = new LifecycleModel(sequence.mode);
    for (const old of document.querySelectorAll('web-sandbox')) old.remove();
    const el = document.createElement('web-sandbox') as any;
    el.style.height = '120px';
    // a document of another window; its load replaces the initial about:blank document in Firefox, so wait for it
    const foreignFrame = document.createElement('iframe');
    const loaded = new Promise(resolve => foreignFrame.addEventListener('load', resolve, { once: true }));
    foreignFrame.srcdoc = '<!DOCTYPE html><body></body>';
    document.body.appendChild(foreignFrame);
    await loaded;
    const foreignDoc = foreignFrame.contentDocument!;
    let failure: string | null = null;
    let failedAt = -1;
    let step = -1;
    let depth = 0;
    let inDom = false;
    let warns = 0;
    const events: Record<string, number> = {};
    const trace: string[] = [];
    const settlements: Promise<void>[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
        warns++;
        void args;
    };
    const fail = (error: unknown) => {
        if (failure !== null) return;
        failure = error instanceof Error ? error.message : String(error);
        failedAt = step;
    };
    const guard = (action: () => void) => {
        if (failure !== null) return;
        try {
            action();
        } catch (error) {
            fail(error);
        }
    };
    // The reducer throws on an input its declaration does not admit (src/lib/lifecycle.ts, LC_INPUTS), in whatever platform
    // callback delivered it: the run fails on it too.
    const onError = (event: ErrorEvent) => {
        if (String(event.message).includes('[Sandbox] lifecycle:')) fail(`an input the declaration does not admit: ${event.message}`);
    };
    addEventListener('error', onError);

    for (const type of EVENTS) {
        el.addEventListener(type, (event: CustomEvent) => guard(() => {
            events[type] = (events[type] ?? 0) + 1;
            trace.push(`  ${'  '.repeat(depth)}event ${type} ${JSON.stringify(event.detail ?? null)?.slice(0, 140)}`);
            model.event({
                type,
                detail: event.detail,
                depth,
                inDom,
                state: el.state,
                frozen: deepFrozen(event.detail),
                now: performance.now(),
            });
        }));
        for (const plan of sequence.plans.filter(candidate => candidate.event === type)) {
            let left = plan.times;
            el.addEventListener(type, () => {
                if (left <= 0 || failure !== null) return;
                left--;
                trace.push(`  ${'  '.repeat(depth)}plan on ${type}: ${JSON.stringify(plan.action)}`);
                runOp(plan.action);
            });
        }
        el.addEventListener(type, () => guard(() => model.eventEnd(type)));
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

    function perform(cmd: Cmd, frame: ReturnType<LifecycleModel['begin']>): { path: string; change: string; text?: string }[] | undefined {
        switch (cmd.op) {
            case 'insert': inDomOperation(() => document.body.appendChild(el)); return;
            case 'remove': inDomOperation(() => el.remove()); return;
            case 'foreign': inDomOperation(() => foreignDoc.body.appendChild(el)); return;
            case 'setConfig': el.setConfig(configOf(cmd.cfg, origin)); return;
            case 'setConfigEqual': el.setConfig(configOf(model.lastDesc!, origin)); return;
            case 'load': el.load(cmd.agent ? COOPERATIVE_AGENT_HTML : '<p>plain</p>'); return;
            case 'reset': el.reset(); return;
            case 'terminate': if (cmd.reason === undefined) el.terminate(); else el.terminate(cmd.reason); return;
            case 'register': el.registerFiles(Object.fromEntries(Object.entries(cmd.files).map(([path, token]) => [path, fileContent(token)]))); return;
            case 'registerBad': el.registerFiles({ '../outside.txt': 'x' }); return;
            case 'unregister': el.unregisterFiles(cmd.paths); return;
            case 'expose': el.expose('hostEcho', cmd.variant === 'echo' ? (env: unknown) => 'echo:' + env : () => { throw new Error('the host refuses'); }); return;
            case 'call': {
                const record = model.calls.get(frame.callId!)!;
                const spec = { ...cmd.spec, env: record.envId ?? 0, id: record.id, url: `${origin}/test/e2e/pixel.png?env=${record.envId}&i=${record.id}` };
                const method = cmd.method === 'act' ? 'act' : cmd.method === 'missing' ? 'missingMethod' : 'm'.repeat(300);
                let extra: unknown = 0;
                if (cmd.arg === 'function') extra = () => 1;
                if (cmd.arg === 'error') extra = new Error('an error argument');
                if (cmd.arg === 'getterThrow') extra = { get x() { throw new Error('the getter throws'); } };
                if (cmd.arg === 'getter') {
                    extra = {
                        get x() {
                            frame.getterRan = true;
                            trace.push(`  ${'  '.repeat(depth)}getter: ${JSON.stringify(cmd.getter)}`);
                            if (cmd.getter) runOp(cmd.getter);
                            return 1;
                        },
                    };
                }
                const promise: Promise<unknown> = cmd.timeout !== undefined ? el.callWithTimeout(rawValue(cmd.timeout), method, spec, extra) : el.call(method, spec, extra);
                settlements.push(promise.then(
                    (value) => ({ status: 'resolved' as const, value }),
                    (error: any) => ({ status: 'rejected' as const, code: error?.code }),
                ).then(outcome => {
                    trace.push(`  settled call ${record.id}: ${JSON.stringify(outcome).slice(0, 120)}`);
                    guard(() => model.settled(record.id, outcome, performance.now()));
                }));
                return;
            }
            case 'execute': {
                const env = model.env?.id ?? 0;
                const id = frame.executed!.id;
                if (cmd.code === 'nonstring') el.execute(42);
                else if (cmd.code === 'agent') el.execute(AGENT_SOURCE);
                else if (cmd.code === 'mark') el.execute(`console.log('[env:${env}] exec ${id}')`);
                else el.execute(`const end = Date.now() + 400; while (Date.now() < end) {}`);
                return;
            }
            case 'listWrites':
                return listingOf(el.listGuestWrites());
            case 'commit': el.commitGuestWrites(cmd.paths, { code: cmd.code }); return;
            default: return;
        }
    }

    function runOp(cmd: Cmd) {
        if (failure !== null) return;
        if (cmd.op === 'setConfigEqual' && !model.lastDesc) return;
        let frame: ReturnType<LifecycleModel['begin']>;
        try {
            // a commit is predicted from the pending list; a path interleaved guest requests left undecided is read first
            frame = model.begin(cmd, performance.now(), cmd.op === 'commit' ? { listed: listingOf(el.listGuestWrites()) } : undefined);
        } catch (error) {
            fail(error);
            return;
        }
        depth++;
        const warnsBefore = warns;
        let threw: string | null = null;
        let listed: ReturnType<typeof perform>;
        try {
            listed = perform(cmd, frame);
        } catch (error: any) {
            threw = String(error?.code ?? error?.name ?? error);
        }
        depth--;
        guard(() => model.end(frame, { threw, warned: warns - warnsBefore, state: el.state, listed }));
    }

    try {
        for (step = 0; step < sequence.cmds.length && failure === null; step++) {
            const cmd = sequence.cmds[step]!;
            trace.push(`#${step} [${model.state}] ${JSON.stringify(cmd)}`);
            if (cmd.op === 'wait') {
                await sleep(cmd.ms);
            } else if (cmd.op === 'settle') {
                const from = performance.now();
                while (!model.quiet && failure === null && performance.now() - from < 8000) await sleep(20);
                if (!model.quiet) fail(`settle: still ${model.state} after 8 s (pending ${JSON.stringify(model.pendingTermination)})`);
                await sleep(20);
            } else {
                runOp(cmd);
                await Promise.resolve();
            }
        }
        step = sequence.cmds.length;
        // the end of a sequence: let it run on, remove the element, every call settles, then nothing more is dispatched
        await sleep(300);
        runOp({ op: 'remove' });
        await Promise.race([Promise.all(settlements), sleep(3000)]);
        guard(() => model.finish());
        await sleep(500);
    } finally {
        removeEventListener('error', onError);
        console.warn = originalWarn;
        el.remove();
        foreignFrame.remove();
    }
    return {
        ok: failure === null,
        ...(failure !== null ? { divergence: failure, step: failedAt } : {}),
        coverage: [...model.coverage],
        events,
        trace: trace.slice(-60),
        ms: Math.round(performance.now() - started),
    };
}

/** The agent's paths, for the spec's documentation of what the prologue registers. */
export const REGISTERED = [AGENT_PATH, BAD_ENTRY_PATH, 'data.txt'];
