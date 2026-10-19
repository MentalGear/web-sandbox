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

/**
 * Review round 5: each finding where the library's own logic decides, reproduced here first against the code it names
 * (each test failed at 60814b5). Each names its class (docs/research/18_finding_classes/README.md). The structural tests
 * that keep each class closed are with its single list or chokepoint: test/unit/egress.test.ts (E-cpu),
 * test/unit/config-schema.test.ts (C), test/unit/element-events.test.ts (D/L), test/unit/read-once.test.ts (G). The
 * findings where the browser decides are in test/e2e/review-round-5.spec.ts.
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
        return { port, load: () => {}, ready: () => el._finishBuild(port) };
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

    it('a model of the rule, over random schedules in every mode: a frame leaves only at `ready` or after, and only for a call still pending then', async () => {
        for (const mode of ['cooperative', 'worker', 'strict'] as const) {
            for (let seed = 1; seed <= 40; seed++) {
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

