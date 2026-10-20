import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineWebSandbox } from '@src/host';
import { createBroker, RPC_MAX_BYTES } from '@src/lib/rpc';
import { createSizeOf } from '@src/lib/structured-size';
import { inSandboxScript } from '@src/lib/in-sandbox-script';
import { isViewFileType, VIEW_WRITE_TYPES } from '@src/lib/in-sandbox-view';
import { mimeTypeFor as typeForPath } from '@src/lib/files';
import { checkIn } from './check-in';

/**
 * Review round 5: each finding where the library's own logic decides, reproduced here first against the code it names
 * (each test failed at 60814b5). Each names its class (docs/research/18_finding_classes/README.md). The structural tests
 * that keep each class closed are with its single list or chokepoint: test/unit/egress.test.ts (E-cpu),
 * test/unit/config-schema.test.ts (C), test/unit/element-events.test.ts (D/L), test/unit/read-once.test.ts (G). The
 * findings where the browser decides are in test/e2e/error-cost-and-queued-calls.spec.ts.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (file: string) => readFileSync(path.join(ROOT, file), 'utf8');

defineWebSandbox();

function element() {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const el = document.createElement('web-sandbox') as any;
    document.body.appendChild(el);
    return { el, warn };
}

const settle = () => new Promise(resolve => setTimeout(resolve, 0));

async function outcome(promise: Promise<unknown>): Promise<{ code: unknown; message: string } | 'resolved' | 'pending'> {
    const settled = promise.then(() => 'resolved' as const, (error: any) => ({ code: error?.code, message: String(error?.message) }));
    return Promise.race([settled, new Promise<'pending'>(resolve => setTimeout(() => resolve('pending'), 50))]);
}

// A seeded generator (mulberry32): the random tests below replay the same cases on every run.
function random(seed: number) {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6D2B79F5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    document.body.replaceChildren();
});

// ---- 5:L-1 (class L): queued calls and execute() leave only at `ready`, in every mode -----------------------------

// A MessagePort stand-in that keeps what is posted on it, synchronously.
class KeptPort {
    readonly posted: unknown[] = [];
    onmessage: unknown = null;
    postMessage(frame: unknown) { this.posted.push(structuredClone(frame)); }
    close() {}
    start() {}
}
class KeptChannel {
    readonly port1 = new KeptPort();
    readonly port2 = new KeptPort();
}

// The element's own build, played by the test: what each mode's frame would do, in its order. Cooperative and worker
// mode: the guest's announcement brings the port and completes the build. Strict mode: the wrapper's load hands the view
// its ports, and the view's check-in (VIEW_READY) completes the build. Returns the port the host posts its frames on.
function playBuild(el: any, mode: 'cooperative' | 'worker' | 'strict') {
    if (el._iframe) el._iframe.onload = null; // jsdom's own load would race the test's
    if (mode !== 'strict') {
        const port = new KeptPort();
        return { port, load: () => {}, ready: () => checkIn(el, port) };
    }
    vi.stubGlobal('MessageChannel', KeptChannel);
    let port: KeptPort | null = null;
    return {
        get port() { return port!; },
        load: () => {
            el._setupStrictChannels({ postMessage() {} });
            port = el._port;
        },
        ready: () => el._onViewMessage(el._viewPort, { type: 'VIEW_READY', width: 300, height: 150 }),
    };
}

const posted = (port: KeptPort) => port.posted.map((frame: any) => frame.type === 'RPC_REQ' ? `call ${frame.args[0]}` : frame.type === 'EXECUTE' ? `execute ${frame.code}` : frame.type);

describe('5:L-1 (class L): a call made while loading that settles before `ready` never runs, in every mode', () => {
    it("strict mode, the owner's repro: a call that times out between the wrapper's load and the view's check-in is never posted", async () => {
        const { el } = element();
        el.setConfig({ mode: 'strict' });
        const build = playBuild(el, 'strict');
        const call = el.callWithTimeout(30, 'm', 'ran');
        build.load(); // at 60814b5 the queue was flushed here, and the call's frame was on its way to the guest
        expect(posted(build.port)).toEqual([]);
        expect(await new Promise(resolve => setTimeout(() => resolve(outcome(call)), 60))).toEqual({ code: 'TIMEOUT', message: 'RPC timeout after 30ms: m' });
        build.ready();
        expect(posted(build.port)).toEqual([]);
        expect(el.state).toBe('ready');
    });

    it('strict mode: a call and an execute() made between the load and `ready` wait for `ready` too, in the order they were made', async () => {
        const { el } = element();
        el.setConfig({ mode: 'strict', scriptUnsafe: true });
        const build = playBuild(el, 'strict');
        el.callWithTimeout(0, 'm', 'before load').catch(() => {});
        build.load();
        el.execute('one()');
        el.callWithTimeout(0, 'm', 'after load').catch(() => {});
        expect(posted(build.port)).toEqual([]);
        build.ready();
        expect(posted(build.port)).toEqual(['call before load', 'execute one()', 'call after load']);
        el.callWithTimeout(0, 'm', 'after ready').catch(() => {});
        expect(posted(build.port).at(-1)).toBe('call after ready');
    });

    // An explicit budget for a fixed amount of work (backlog T6): SEEDS schedules per mode, each one element built in
    // jsdom (about four fifths of the cost) and 101 steps of the fake clock. Nothing grows from one schedule to the
    // next: measured, about 100 ms for the first (jsdom warming up), then 6–34 ms each to the last. It is all CPU: 1.4–1.7 s
    // alone, 1.5 s in a full idle run on 4 cores, 3.3–4.6 s in full runs with two busy loops on the machine (load
    // average 8). Vitest's default 5 s is 3 times the idle cost, which a loaded machine passes. The budget is 250 ms
    // per schedule, about 20 times the idle cost.
    const SEEDS = 40;
    const MODES = ['cooperative', 'worker', 'strict'] as const;
    it('a model of the rule, over random schedules in every mode: a frame leaves only at `ready` or after, and only for a call still pending then', { timeout: MODES.length * SEEDS * 250 }, async () => {
        for (const mode of MODES) {
            for (let seed = 1; seed <= SEEDS; seed++) {
                vi.useFakeTimers(); // before the element: its broker takes the timers it finds when it is made
                const next = random(seed * 7919 + mode.length);
                const { el } = element();
                el.setConfig(mode === 'cooperative' ? { mode, capabilities: ['allow-scripts'] } : { mode });
                const build = playBuild(el, mode);
                const loadAt = Math.floor(next() * 40);
                const readyAt = mode === 'strict' ? loadAt + Math.floor(next() * 40) : loadAt;
                const calls: { at: number; timeout: number; index: number; settledAt: number | null }[] = [];
                let readyTime = -1;
                let sentBeforeReady = 0;
                for (let time = 0; time <= 100; time++) {
                    if (time === loadAt) build.load();
                    if (time === readyAt) {
                        sentBeforeReady = build.port ? build.port.posted.length : 0;
                        build.ready();
                        readyTime = time;
                    }
                    if (next() < 0.15) {
                        const record = { at: time, timeout: next() < 0.2 ? 0 : 1 + Math.floor(next() * 60), index: calls.length, settledAt: null as number | null };
                        calls.push(record);
                        el.callWithTimeout(record.timeout, 'm', record.index).catch(() => { record.settledAt = record.at + record.timeout; });
                    }
                    await vi.advanceTimersByTimeAsync(1);
                }
                const sent = build.port.posted.filter((frame: any) => frame.type === 'RPC_REQ').map((frame: any) => frame.args[0] as number);
                // nothing leaves before `ready`
                expect(sentBeforeReady, `${mode} seed ${seed}`).toBe(0);
                // what leaves: every call made after `ready`, and every call made before it that was still pending at `ready`
                const expected = calls.filter(call => call.at >= readyTime || call.timeout === 0 || call.at + call.timeout > readyTime).map(call => call.index);
                expect(sent, `${mode} seed ${seed}`).toEqual(expected);
                document.body.replaceChildren();
                vi.useRealTimers();
                vi.unstubAllGlobals();
            }
        }
    });
});

// ---- 5:L-2 = N-5 (class C): a call heavier than the byte budget is refused for good, never BUSY forever --------------

// Strict mode's comms script (the bootstrap as the worker runs it), attached to a real port; what it posts arrives in `sent`.
function attachedStrictComms(callBudget: { calls: number; bytes: number }) {
    const sent: any[] = [];
    const { port1, port2 } = new MessageChannel();
    port2.onmessage = (event) => sent.push(event.data);
    inSandboxScript(false, 'strict', console, createBroker, { externalPort: true, callBudget }, createSizeOf).attach(port1);
    return {
        sent,
        close: () => {
            port1.close();
            port2.close();
            delete (globalThis as any).bridge;
            delete (globalThis as any).sandboxFetch;
        },
    };
}

describe('5:L-2 (class C): callLimits.maxBytesPerSecond smaller than one call', () => {
    it.each([64, 100])('maxBytesPerSecond: %i — the guest\'s bridge refuses every call ARGS_NOT_TRANSFERABLE (not retryable), never BUSY', async (bytes) => {
        const { sent, close } = attachedStrictComms({ calls: 1000, bytes });
        const result = await outcome((globalThis as any).bridge.call('m'));
        await settle();
        close();
        expect(result).toMatchObject({ code: 'ARGS_NOT_TRANSFERABLE' });
        expect(sent.filter((frame: any) => frame?.type === 'RPC_REQ')).toEqual([]);
    });

    it.each([64, 100])('maxBytesPerSecond: %i — the element answers a call that arrives anyway ARGS_NOT_TRANSFERABLE, and its method does not run', async (bytes) => {
        const { el } = element();
        el.setConfig({ mode: 'cooperative', capabilities: ['allow-scripts'], callLimits: { maxBytesPerSecond: bytes } });
        const method = vi.fn(() => 'ran');
        el.expose('m', method);
        const answers: any[] = [];
        el._broker.handleMessage({ type: 'RPC_REQ', id: 1, method: 'm', args: [] }, (frame: unknown) => answers.push(frame));
        await settle();
        expect(method).not.toHaveBeenCalled();
        expect(answers).toEqual([expect.objectContaining({ type: 'RPC_RES', id: 1, ok: false, code: 'ARGS_NOT_TRANSFERABLE' })]);
    });

    it('a maxBytesPerSecond below the largest call gives one warning, that calls heavier than it are refused; at or above it, none', () => {
        const { el, warn } = element();
        for (const bytes of [100, 1048576, RPC_MAX_BYTES - 1, RPC_MAX_BYTES, 67108864]) {
            warn.mockClear();
            el.setConfig({ mode: 'cooperative', capabilities: ['allow-scripts'], callLimits: { maxBytesPerSecond: bytes } });
            el.setConfig({ mode: 'cooperative', capabilities: ['allow-scripts'], callLimits: { maxBytesPerSecond: bytes }, html: 'again' });
            const said = warn.mock.calls.map(call => String(call[0])).filter(message => message.includes('callLimits'));
            expect(said, String(bytes)).toEqual(bytes < RPC_MAX_BYTES
                ? [`[Sandbox] callLimits.maxBytesPerSecond is ${bytes}, below the largest call (${RPC_MAX_BYTES} bytes): a call heavier than ${bytes} bytes is refused with ARGS_NOT_TRANSFERABLE.`]
                : []);
        }
    });
});

// ---- 5:L-3 (class D/L): every detail is frozen, deeply ---------------------------------------------------------------

describe('5:L-3 (class D/L): the first listener cannot rewrite a detail for the listeners after it', () => {
    it('terminated: { reason } is frozen; a listener that rewrites it changes nothing for the next', () => {
        const { el } = element();
        const seen: unknown[] = [];
        el.addEventListener('terminated', (e: CustomEvent) => { Reflect.set(e.detail, 'reason', 'rewritten'); });
        el.addEventListener('terminated', (e: CustomEvent) => { seen.push(e.detail.reason, Object.isFrozen(e.detail)); });
        el.terminate('the reason');
        expect(seen).toEqual(['the reason', true]);
    });

    it('fileschanged: { paths } and its array are frozen', () => {
        const { el } = element();
        const seen: unknown[] = [];
        el.addEventListener('fileschanged', (e: CustomEvent) => { Reflect.set(e.detail.paths, 0, 'rewritten'); });
        el.addEventListener('fileschanged', (e: CustomEvent) => { seen.push([...e.detail.paths], Object.isFrozen(e.detail), Object.isFrozen(e.detail.paths)); });
        el.registerFiles({ 'a.txt': 'x' });
        expect(seen).toEqual([['a.txt'], true, true]);
    });

    it("sandbox-log: the objects and arrays of the guest's arguments are frozen too", () => {
        const { el } = element();
        const seen: unknown[] = [];
        el.addEventListener('sandbox-log', (e: CustomEvent) => { Reflect.set(e.detail.args[0].nested, 'list', 'rewritten'); });
        el.addEventListener('sandbox-log', (e: CustomEvent) => { seen.push(e.detail.args[0].nested.list, Object.isFrozen(e.detail.args[0]), Object.isFrozen(e.detail.args[0].nested.list)); });
        el._dispatchLog({ level: 'log', args: [{ nested: { list: [1, 2] } }] }, 'guest');
        expect(seen).toEqual([[1, 2], true, true]);
    });
});

// ---- 5:N-4 and 5:L-4 (class D): the view, the list and the announcement are projections of one diff ----------------

// The strict view as the element talks to it: the paths it resolves, from the build's files and the VIEW_WRITE frames,
// and each VIEW_WRITE answered at once (VIEW_WRITTEN), as the view does once it holds the change.
function fakeView(el: any) {
    const shows = new Map<string, boolean>(); // path → shows something; unset: as the build delivered it
    const port = {
        postMessage(frame: any) {
            if (frame.type !== 'VIEW_WRITE') return;
            shows.set(frame.path, typeof frame.mime === 'string' && VIEW_WRITE_TYPES.includes(frame.mime) && frame.bytes instanceof Uint8Array);
            queueMicrotask(() => el._onViewMessage(port, { type: 'VIEW_WRITTEN', id: frame.id }));
        },
        close() {},
    };
    el._viewPort = port;
    return { shows };
}

const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

describe('5:N-4 and 5:L-4 (class D): one diff of the guest-write state', () => {
    it('N-4: a removal of a file the host unregistered after the build is shown in the view, and announced nowhere', async () => {
        const { el } = element();
        el.registerFiles({ 'pic.png': PNG });
        el.setConfig({ mode: 'strict', guestWrites: true });
        const view = fakeView(el);
        const heard: string[][] = [];
        el.addEventListener('fileswritten', (e: CustomEvent) => heard.push([...e.detail.paths]));
        el.unregisterFiles(['pic.png']);
        const answer = await el._handleGuestWrite(el._guestWrites, { change: 'remove', path: 'pic.png' });
        expect(answer).toEqual({ path: 'pic.png', change: 'remove' });
        expect(el.listGuestWrites()).toEqual([]);
        expect(heard).toEqual([]);
        expect(view.shows.get('pic.png')).toBe(false); // at 60814b5 the view was never told, and kept the old blob: URL
    });

    it('L-4: a withdrawn write (a new path written, then removed) is announced, since the list changed, and listed nowhere; docs/API.md says so', async () => {
        const { el } = element();
        el.setConfig({ mode: 'strict', guestWrites: true });
        fakeView(el);
        const heard: string[][] = [];
        el.addEventListener('fileswritten', (e: CustomEvent) => heard.push([...e.detail.paths]));
        await el._handleGuestWrite(el._guestWrites, { change: 'write', path: 'new.txt', entry: 'x' });
        await el._handleGuestWrite(el._guestWrites, { change: 'remove', path: 'new.txt' });
        expect(heard).toEqual([['new.txt'], ['new.txt']]);
        expect(el.listGuestWrites()).toEqual([]);
        expect(read('docs/API.md').replace(/\s+/g, ' ')).toContain('A removal of a path the guest wrote and the files do not hold withdraws the write');
    });

    it('a model over random sequences of guest writes and removals and host registrations, removals and commits: the announcement names exactly the paths whose listed entry changed, and the view shows exactly what the guest sees', async () => {
        const PATHS = ['a.png', 'b.txt', 'c.png', 'd.css'];
        const content = (pathName: string, version: number) => (pathName.endsWith('.png') ? new Uint8Array([...PNG, version]) : `v${version}`);
        for (let seed = 1; seed <= 60; seed++) {
            const next = random(seed);
            const pick = () => PATHS[Math.floor(next() * PATHS.length)]!;
            const { el } = element();
            const registered: Record<string, unknown> = {};
            for (const candidate of PATHS) if (next() < 0.5) registered[candidate] = content(candidate, 0);
            if (Object.keys(registered).length > 0) el.registerFiles(registered);
            el.setConfig({ mode: 'strict', guestWrites: true });
            const view = fakeView(el);
            // what the guest's own sandboxFiles holds (the build's files, then the element's answers): path → its type
            const guest = new Map<string, { type: string; built: boolean }>();
            for (const [candidate] of Object.entries(registered)) guest.set(candidate, { type: typeForPath(candidate), built: true });
            let heard: string[] = [];
            el.addEventListener('fileswritten', (e: CustomEvent) => heard.push(...e.detail.paths));
            const listed = () => JSON.stringify(el.listGuestWrites().map((entry: any) => (entry.content ? { ...entry, content: [...entry.content] } : entry)));
            for (let step = 0; step < 25; step++) {
                const roll = next();
                const target = pick();
                if (roll < 0.15) {
                    el.registerFiles({ [target]: content(target, step + 1) });
                    continue;
                }
                if (roll < 0.25) {
                    el.unregisterFiles([target]);
                    continue;
                }
                if (roll < 0.3) {
                    try { el.commitGuestWrites([target], { code: true }); } catch { /* a refused commit changes nothing */ }
                    continue;
                }
                const before = JSON.parse(listed()).find((entry: any) => entry.path === target) ?? null;
                heard = [];
                const request = roll < 0.65 ? { change: 'write', path: target, entry: content(target, step + 1) } : { change: 'remove', path: target };
                let answer: any = null;
                try {
                    answer = await el._handleGuestWrite(el._guestWrites, request);
                } catch {
                    continue; // refused: nothing changed (FILES_BUSY cannot happen at 25 requests)
                }
                if (answer.change === 'write') guest.set(target, { type: answer.type, built: false });
                if (answer.change === 'remove') guest.delete(target);
                const after = JSON.parse(listed()).find((entry: any) => entry.path === target) ?? null;
                const where = `seed ${seed} step ${step}: ${request.change} ${target}`;
                expect(heard, where).toEqual(JSON.stringify(before) === JSON.stringify(after) ? [] : [target]);
                for (const candidate of PATHS) {
                    const seen = guest.get(candidate);
                    const expected = !!seen && (seen.built ? isViewFileType(seen.type) : VIEW_WRITE_TYPES.includes(seen.type));
                    const shown = view.shows.has(candidate) ? view.shows.get(candidate) : !!registered[candidate] && isViewFileType(typeForPath(candidate));
                    expect(shown, `${where}: the view at ${candidate}`).toBe(expected);
                }
            }
            document.body.replaceChildren();
            vi.restoreAllMocks();
        }
    });
});

// ---- 5:N-6 (class G): sandboxFetch reads its init once ---------------------------------------------------------------

describe('5:N-6 (class G): a guest value is read once, at the boundary', () => {
    it('sandboxFetch reads init.method, headers and body once each, and sends what it read', async () => {
        const { sent, close } = attachedStrictComms({ calls: 1000, bytes: 67108864 });
        const reads: Record<string, number> = { method: 0, headers: 0, body: 0 };
        const init = {
            get method() { reads.method!++; return reads.method === 1 ? 'GET' : { toString: () => 'x'.repeat(1 << 20) }; },
            get headers() { reads.headers!++; return { accept: 'text/plain' }; },
            get body() { reads.body!++; return undefined; },
        };
        void (globalThis as any).sandboxFetch('https://api.example/x', init).catch(() => {});
        await settle();
        close();
        expect(reads).toEqual({ method: 1, headers: 1, body: 1 });
        const request = sent.find(frame => frame.type === 'RPC_REQ')!.args[0];
        expect(request.method).toBe('GET');
    });
});
