import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { inSandboxScript } from '@src/lib/in-sandbox-script';
import { inSandboxFiles } from '@src/lib/in-sandbox-files';
import { inSandboxView, sanitizeRender, VIEW_MAX_OPERATION_MS, VIEW_OPTIONS, VIEW_OVERRUN_WINDOW_MS, viewBootstrapSource } from '@src/lib/in-sandbox-view';
import { defineWebSandbox } from '@src/host';
import { createBroker } from '@src/lib/rpc';
import { createSizeOf } from '@src/lib/structured-size';
import { LOG_EVENTS_PER_SECOND, LOG_MAX_BYTES } from '@src/lib/sandbox-log';
import { createFetchBridge, toFetchPolicy, type FetchRecord } from '@src/lib/fetch-bridge';
import { SyntaxKind, tokenize, type Token } from '../../scripts/js-tokens';

/**
 * Review round 3: each finding where the library's own logic decides, reproduced here first against the code it names
 * (each test failed at 16c545b). The findings where the browser decides are in test/e2e/review-round-3.spec.ts. The
 * bootstrap runs against stand-in ports whose postMessage structured-clones the frame, as a browser's does (as in
 * review-round-2.test.ts).
 */

class FakeEvent {
    stopImmediatePropagation() {}
}
class FakeMessageEvent extends FakeEvent {
    readonly isTrusted = true;
    constructor(private readonly init: { data?: unknown; ports?: unknown[] }) { super(); }
    get data() { return this.init.data; }
    get ports() { return this.init.ports ?? []; }
}
class ClonePort {
    frames: any[] = [];
    private handler: ((event: unknown) => void) | null = null;
    postMessage(frame: unknown) { this.frames.push(structuredClone(frame)); }
    get onmessage() { return this.handler; }
    set onmessage(handler) { this.handler = handler; }
    deliver(data: unknown) { this.handler!(new FakeMessageEvent({ data })); }
}
class FakeMessageChannel {
    static last: FakeMessageChannel | null = null;
    readonly port1 = new ClonePort();
    readonly port2 = new ClonePort();
    constructor() { FakeMessageChannel.last = this; }
}
const PLATFORM = { MessagePort: ClonePort, MessageEvent: FakeMessageEvent, Event: FakeEvent, MessageChannel: FakeMessageChannel };
const originals: Record<string, unknown> = {};
const originalAddEventListener = globalThis.addEventListener;

// The real platform (jsdom's) for the tests that run the element or the view, not the stand-ins.
function realPlatform() {
    for (const name of Object.keys(PLATFORM)) (globalThis as any)[name] = originals[name];
    (globalThis as any).addEventListener = originalAddEventListener;
}

beforeEach(() => {
    for (const [name, value] of Object.entries(PLATFORM)) {
        originals[name] = (globalThis as any)[name];
        (globalThis as any)[name] = value;
    }
    (globalThis as any).addEventListener = () => {};
    vi.spyOn(window, 'postMessage').mockImplementation(() => {});
});

afterEach(() => {
    globalThis.addEventListener = originalAddEventListener;
    for (const name of Object.keys(PLATFORM)) (globalThis as any)[name] = originals[name];
    delete (globalThis as any).bridge;
    delete (globalThis as any).sandboxFiles;
    delete (globalThis as any).sandboxFetch;
    vi.useRealTimers();
    vi.restoreAllMocks();
    document.body.replaceChildren();
});

const SILENT_CONSOLE = new Proxy({}, { get: () => () => {} }) as Console;
const CALL_BUDGET = { calls: 1000, bytes: 67108864 }; // the defaults (docs/API.md, Limits; review round 4, M-6: 1000 calls)

/** The bootstrap as the host builds it in strict mode (externalPort), attached to a cloning port. */
function strictComms(console: Console = SILENT_CONSOLE, features: Record<string, unknown> = {}) {
    const comms = inSandboxScript(false, 'strict', console, createBroker, { externalPort: true, ...features }, createSizeOf);
    const port = new ClonePort();
    comms.attach(port as any);
    port.frames.length = 0;
    return { comms, port, lines: () => port.frames.filter(frame => frame.type === 'LOG') };
}

/** A broker whose frames are captured, and one call answered with `frame` (its id filled in). */
function capturedBroker(options: Record<string, unknown> = {}) {
    const frames: any[] = [];
    const broker = createBroker((frame) => { frames.push(structuredClone(frame)); }, { timeoutMs: 0, sizeOf: createSizeOf(), ...options });
    return { broker, frames };
}

async function outcome(promise: Promise<unknown>): Promise<{ code: unknown; message: string } | 'resolved' | 'pending'> {
    const settled = promise.then(() => 'resolved' as const, (error: any) => ({ code: error?.code, message: String(error?.message) }));
    return Promise.race([settled, new Promise<'pending'>(resolve => setTimeout(() => resolve('pending'), 50))]);
}

// A request frame as the other side's broker would post it.
const request = (id: unknown, method: unknown, args: unknown[] = []) => ({ type: 'RPC_REQ', id, method, args });

const settle = () => new Promise(resolve => setTimeout(resolve, 0));

describe('C-1: every RPC frame is built from bounded parts at the sender, and checked again where it arrives', () => {
    it('a call to a method name longer than 256 characters is refused INVALID_CALL and nothing is sent; 256 characters are sent', async () => {
        const { broker, frames } = capturedBroker();
        expect(await outcome(broker.call('m'.repeat(257)))).toEqual({ code: 'INVALID_CALL', message: 'RPC method name must be a string of at most 256 characters' });
        expect(frames).toEqual([]);
        void broker.call('m'.repeat(256));
        expect(frames.map(frame => frame.method.length)).toEqual([256]);
    });

    it('a request naming a longer method is answered UNKNOWN_METHOD without echoing the name', () => {
        const { broker, frames } = capturedBroker();
        broker.handleMessage(request(1, 'x'.repeat(2 ** 20)));
        expect(frames).toEqual([{ type: 'RPC_RES', id: 1, ok: false, error: 'the method name is longer than 256 characters', code: 'UNKNOWN_METHOD' }]);
    });

    it('a request whose id is a string longer than 256 characters is dropped, as a malformed frame', () => {
        const { broker, frames } = capturedBroker();
        broker.expose('m', () => 1);
        broker.handleMessage(request('i'.repeat(257), 'm'));
        broker.handleMessage(request('unknown'.repeat(100), 'nothing'));
        expect(frames).toEqual([]);
    });

    it("a handler's error text is cut to 65536 characters, the marker included", async () => {
        const { broker, frames } = capturedBroker();
        broker.expose('throws', () => { throw new Error('e'.repeat(2 ** 20)); });
        broker.expose('rejects', () => Promise.reject('r'.repeat(2 ** 20)));
        broker.handleMessage(request(1, 'throws'));
        broker.handleMessage(request(2, 'rejects'));
        await settle();
        expect(frames.map(frame => [frame.code, frame.error.length, frame.error.endsWith('[… cut at 65536 characters]')])).toEqual([
            ['HANDLER_ERROR', 65536, true],
            ['HANDLER_ERROR', 65536, true],
        ]);
    });

    it('a reported error text is cut again on receipt; a cut text is not cut twice', async () => {
        const { broker, frames } = capturedBroker();
        const huge = broker.call('a');
        broker.handleMessage({ type: 'RPC_RES', id: frames[0].id, ok: false, error: 'x'.repeat(2 ** 20), code: 'HANDLER_ERROR' });
        const first = await outcome(huge) as { message: string };
        expect([first.message.length, first.message.endsWith('[… cut at 65536 characters]')]).toEqual([65536, true]);
        const again = broker.call('b');
        broker.handleMessage({ type: 'RPC_RES', id: frames[1].id, ok: false, error: first.message, code: 'HANDLER_ERROR' });
        expect(((await outcome(again)) as { message: string }).message).toBe(first.message);
    });

    it('the whole frame is measured where it arrives, not only its arguments or value', async () => {
        const { broker, frames } = capturedBroker();
        let ran = 0;
        broker.expose('m', () => { ran++; });
        broker.handleMessage({ ...request(1, 'm'), padding: 'p'.repeat(18_000_000) });
        await settle();
        expect([ran, frames[0].code]).toEqual([0, 'ARGS_NOT_TRANSFERABLE']); // review round 4, C-5: never carried, not retryable
        const call = broker.call('n');
        broker.handleMessage({ type: 'RPC_RES', id: frames[1].id, ok: true, value: 1, padding: 'p'.repeat(18_000_000) });
        expect(await outcome(call)).toMatchObject({ code: 'RESULT_NOT_TRANSFERABLE' });
    });

    it("expose() ignores a name longer than 256 characters; the element's expose() says so at once", () => {
        const { broker, frames } = capturedBroker();
        broker.expose('n'.repeat(257), () => 1);
        broker.handleMessage(request(1, 'n'.repeat(257)));
        expect(frames[0].code).toBe('UNKNOWN_METHOD');
        defineWebSandbox();
        const el = document.createElement('web-sandbox') as any;
        expect(() => el.expose('n'.repeat(257), () => 1)).toThrow(TypeError);
        expect(() => el.expose('n'.repeat(256), () => 1)).not.toThrow();
    });

    // By construction: every RPC frame anything in src/ posts is made by one of the builders inside createBroker, from
    // parts each of which is bounded there. A literal 'RPC_REQ' or 'RPC_RES' anywhere else may only be compared with.
    it('every RPC_REQ and RPC_RES frame is made by the one builder in createBroker, and every frame the broker posts is one of its frames', () => {
        const BUILDERS = ['requestFrame', 'resultFrame', 'refusalFrame'];
        const files = (directory: string): string[] => readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
            const path = join(directory, entry.name);
            if (entry.isDirectory()) return files(path);
            return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [path] : [];
        });
        // The token range of `function <name>`'s body in `tokens`.
        const bodyOf = (tokens: Token[], name: string): [number, number] | null => {
            const at = tokens.findIndex((token, i) => token.text === name && tokens[i - 1]?.kind === SyntaxKind.FunctionKeyword);
            if (at < 0) return null;
            let open = at;
            while (tokens[open]!.kind !== SyntaxKind.OpenBraceToken) open++;
            let depth = 0;
            for (let i = open; i < tokens.length; i++) {
                if (tokens[i]!.kind === SyntaxKind.OpenBraceToken) depth++;
                if (tokens[i]!.kind === SyntaxKind.CloseBraceToken && --depth === 0) return [open, i];
            }
            return null;
        };
        const found: string[] = [];
        let built = 0;
        for (const path of files('src')) {
            const tokens = tokenize(readFileSync(path, 'utf8'));
            const builders = path === join('src', 'lib', 'rpc.ts') ? BUILDERS.map(name => bodyOf(tokens, name)) : [];
            for (let i = 0; i < tokens.length; i++) {
                const token = tokens[i]!;
                if (token.kind !== SyntaxKind.StringLiteral || !/^['"]RPC_RE[QS]['"]$/.test(token.text)) continue;
                const before = tokens[i - 1]?.kind;
                if (before === SyntaxKind.EqualsEqualsEqualsToken || before === SyntaxKind.ExclamationEqualsEqualsToken) continue;
                if (builders.some(range => range !== null && i > range[0] && i < range[1])) {
                    built++;
                    continue;
                }
                found.push(`${path}: ${token.text} outside the builder`);
            }
        }
        expect(found).toEqual([]);
        expect(built).toBe(3); // one frame per builder
        // Inside createBroker every post (`send(` and `respond(`) hands on a builder's frame: a builder's call, or a
        // constant that holds one (`const frame = resultFrame(…)`, measured before it is posted).
        const tokens = tokenize(createBroker.toString());
        const frames = new Set(tokens.flatMap((token, i) => (tokens[i - 1]?.kind === SyntaxKind.ConstKeyword && tokens[i + 1]?.kind === SyntaxKind.EqualsToken && BUILDERS.includes(tokens[i + 2]!.text) ? [token.text] : [])));
        let posts = 0;
        for (let i = 0; i < tokens.length; i++) {
            const name = tokens[i]!.text;
            if ((name !== 'send' && name !== 'respond') || tokens[i + 1]?.kind !== SyntaxKind.OpenParenToken || tokens[i - 1]?.kind === SyntaxKind.DotToken) continue;
            if (tokens[i - 1]?.kind === SyntaxKind.FunctionKeyword || tokens[i - 1]?.kind === SyntaxKind.ColonToken) continue;
            posts++;
            const argument = tokens[i + 2]!.text;
            if (!BUILDERS.includes(argument) && !frames.has(argument)) found.push(`${name}(${argument} …)`);
        }
        expect(found).toEqual([]);
        expect(posts).toBeGreaterThan(8);
    });
});

describe('C-3: a value the measure does not know is named as such; a byte budget is named only when it was exceeded', () => {
    // One relay per test (the strict bootstrap's `log`, the one chokepoint every console call goes through), and its last line.
    let lastLine: () => any = () => undefined;
    function relay() {
        const comms = strictComms();
        lastLine = () => comms.lines().at(-1);
        return comms.comms;
    }

    it('console.log({ error: new Error("boom") }) carries the error as { name, message, stack }', () => {
        const log = relay();
        const error = new Error('boom');
        log.log('log', [{ error }]);
        expect(lastLine().args).toEqual([{ error: { name: 'Error', message: 'boom', stack: error.stack } }]);
    });

    it('errors anywhere in an argument: in arrays, Maps, Sets, Promise.allSettled results, nested objects', async () => {
        const log = relay();
        const settled = await Promise.allSettled([Promise.reject(new TypeError('t')), Promise.resolve(1)]);
        log.log('log', [[new TypeError('one')], settled, new Map([['k', new RangeError('m')]]), new Set([new SyntaxError('s')]), { deep: [{ e: new EvalError('d') }] }]);
        const [array, results, map, set, deep] = lastLine().args;
        expect(array).toEqual([{ name: 'TypeError', message: 'one', stack: expect.any(String) }]);
        expect(results).toEqual([{ status: 'rejected', reason: { name: 'TypeError', message: 't', stack: expect.any(String) } }, { status: 'fulfilled', value: 1 }]);
        expect([...map]).toEqual([['k', { name: 'RangeError', message: 'm', stack: expect.any(String) }]]);
        expect([...set]).toEqual([{ name: 'SyntaxError', message: 's', stack: expect.any(String) }]);
        expect(deep.deep[0].e).toEqual({ name: 'EvalError', message: 'd', stack: expect.any(String) });
    });

    it('the walk runs no guest code with the snapshot at hand: a Symbol.toStringTag getter cannot reach a line waiting for the port', () => {
        const comms = inSandboxScript(false, 'strict', SILENT_CONSOLE, createBroker, { externalPort: true }, createSizeOf);
        const receivers: object[] = [];
        const tag = Object.getOwnPropertyDescriptor(Object.prototype, Symbol.toStringTag);
        Object.defineProperty(Object.prototype, Symbol.toStringTag, { configurable: true, get() { receivers.push(this); return undefined; } });
        try {
            comms.log('log', [{ nested: { list: [1, 2] }, error: new Error('e') }]); // before the port: the line waits
        } finally {
            if (tag) Object.defineProperty(Object.prototype, Symbol.toStringTag, tag);
            else delete (Object.prototype as any)[Symbol.toStringTag];
        }
        for (const receiver of receivers) (receiver as any).grown = 'g'.repeat(1000); // what guest code holding one could do
        const port = new ClonePort();
        comms.attach(port as any);
        const line = port.frames.find(frame => frame.type === 'LOG' && typeof frame.args[0] === 'object');
        expect(line.args).toEqual([{ nested: { list: [1, 2] }, error: { name: 'Error', message: 'e', stack: expect.any(String) } }]);
    });

    it('a kind the measure does not know says "unsupported value: <kind>", never "byte budget"', () => {
        const log = relay();
        let nested: unknown = new Error('deep');
        for (let i = 0; i < 200; i++) nested = [nested]; // past the walk's depth: the error stays, and is named
        log.log('log', [{ shared: new SharedArrayBuffer(8) }, nested, 'after']);
        expect(lastLine().args).toEqual(['[unsupported value: SharedArrayBuffer]', '[unsupported value: Error]', 'after']);
    });

    it('M-7: a value past the budget says so once, with its kind in one pair of brackets', () => {
        const log = relay();
        log.log('log', [new Uint8Array(LOG_MAX_BYTES + 1)]);
        expect(lastLine().args).toEqual([`[Uint8Array: past the log line's byte budget (${LOG_MAX_BYTES})]`]);
    });

    it('RPC: arguments or a result holding an Error are refused as unsupported, not as larger than the budget; a large one still is', async () => {
        const { broker, frames } = capturedBroker();
        expect(await outcome(broker.call('m', { error: new Error('boom') }))).toEqual({ code: 'ARGS_NOT_TRANSFERABLE', message: 'RPC arguments hold an unsupported value: Error' });
        expect(await outcome(broker.call('m', 'x'.repeat(18_000_000)))).toMatchObject({ code: 'ARGS_NOT_TRANSFERABLE', message: 'RPC arguments are larger than the RPC byte budget (34603008)' });
        expect(frames).toEqual([]);
        broker.expose('answer', () => ({ error: new TypeError('t') }));
        broker.handleMessage(request(1, 'answer'));
        await settle();
        expect(frames[0]).toMatchObject({ ok: false, code: 'RESULT_NOT_TRANSFERABLE', error: 'the result holds an unsupported value: Error' });
        const call = broker.call('n');
        broker.handleMessage({ type: 'RPC_RES', id: frames[1].id, ok: true, value: [new Error('x')] });
        expect(await outcome(call)).toEqual({ code: 'RESULT_NOT_TRANSFERABLE', message: 'the result holds an unsupported value: Error' });
    });
});

describe('M-2: the calls the guest initiates have a per-second budget, in the guest and again on the host', () => {
    it("the guest's broker refuses the call past 1000 in one second BUSY, locally, and posts nothing for it; a second later calls go again", async () => {
        let now = 1000;
        vi.spyOn(performance, 'now').mockImplementation(() => now);
        const { comms, port } = strictComms(SILENT_CONSOLE, { callBudget: CALL_BUDGET });
        void comms;
        const bridge = (globalThis as any).bridge;
        for (let i = 0; i < CALL_BUDGET.calls; i++) void bridge.callWithTimeout(0, 'm');
        const requests = () => port.frames.filter(frame => frame.type === 'RPC_REQ').length;
        expect(requests()).toBe(CALL_BUDGET.calls);
        expect(await outcome(bridge.callWithTimeout(0, 'm'))).toEqual({ code: 'BUSY', message: 'more than 1000 calls or 67108864 bytes of calls in one second' });
        expect(requests()).toBe(CALL_BUDGET.calls);
        now += 1000;
        void bridge.callWithTimeout(0, 'm');
        expect(requests()).toBe(CALL_BUDGET.calls + 1);
    });

    it("the guest's broker counts bytes too: a third call of 30 MiB in one second is BUSY", async () => {
        let now = 1000;
        vi.spyOn(performance, 'now').mockImplementation(() => now);
        strictComms(SILENT_CONSOLE, { callBudget: CALL_BUDGET });
        const bridge = (globalThis as any).bridge;
        const big = 'x'.repeat(15_000_000); // 30 MB measured
        expect(await outcome(bridge.callWithTimeout(0, 'm', big))).toBe('pending');
        expect(await outcome(bridge.callWithTimeout(0, 'm', big))).toBe('pending');
        expect(await outcome(bridge.callWithTimeout(0, 'm', big))).toMatchObject({ code: 'BUSY' });
        now += 1000;
        expect(await outcome(bridge.callWithTimeout(0, 'm', big))).toBe('pending');
    });

    // The host checks the same window on receipt: frames that did not come through the guest's broker's check (a guest
    // broker of an older bootstrap, or delivery bunched up) are answered BUSY there.
    function hostWithPort() {
        realPlatform();
        defineWebSandbox();
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const el = document.createElement('web-sandbox') as any;
        document.body.appendChild(el);
        el.setConfig({ mode: 'cooperative', capabilities: ['allow-scripts'] });
        const { port1 } = new MessageChannel();
        el._port = port1;
        const answers: any[] = [];
        const deliver = (frame: unknown) => el._onGuestMessage(port1, (answer: unknown) => answers.push(answer), frame, null);
        return { el, answers, deliver, done: () => port1.close() };
    }

    it('the host answers BUSY to a call past 1000 in one second, before its method runs', async () => {
        let now = 1000;
        vi.spyOn(performance, 'now').mockImplementation(() => now);
        const { el, answers, deliver, done } = hostWithPort();
        let ran = 0;
        el.expose('noop', () => { ran++; });
        for (let i = 1; i <= CALL_BUDGET.calls + 1; i++) deliver(request(i, 'noop'));
        await settle();
        expect(ran).toBe(CALL_BUDGET.calls);
        expect(answers.filter(answer => answer.code === 'BUSY').map(answer => [answer.id, answer.error])).toEqual([[CALL_BUDGET.calls + 1, 'more than 1000 calls or 67108864 bytes of calls in one second']]);
        now += 1000;
        deliver(request(0, 'noop'));
        await settle();
        expect(ran).toBe(CALL_BUDGET.calls + 1);
        done();
    });

    it('the host counts bytes too: the third call of 30 MiB in one second is BUSY, even when the earlier ones settled', async () => {
        vi.spyOn(performance, 'now').mockImplementation(() => 1000);
        const { el, answers, deliver, done } = hostWithPort();
        el.expose('noop', () => {});
        const big = 'x'.repeat(15_000_000);
        for (let i = 1; i <= 3; i++) {
            deliver(request(i, 'noop', [big]));
            await settle(); // settled: nothing is in flight, so only the per-second budget can refuse it
        }
        expect(answers.map(answer => answer.code ?? 'ok')).toEqual(['ok', 'ok', 'BUSY']);
        done();
    });

    it("both ends take the budget from one place, the element's config: the guest's bootstrap carries the host's values", () => {
        realPlatform();
        defineWebSandbox();
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const el = document.createElement('web-sandbox') as any;
        document.body.appendChild(el);
        el.setConfig({ mode: 'cooperative', capabilities: ['allow-scripts'] });
        expect(el._callBudget).toEqual(CALL_BUDGET);
        const literal = JSON.stringify(CALL_BUDGET);
        expect(el._getSandboxCommsScript('cooperative', [])).toContain(`"callBudget":${literal}`);
        expect(el._getStrictWorkerSource([], '')).toContain(`"callBudget":${literal}`);
    });
});

describe("L-4: guest lines the host's window drops are announced in 'sandbox-log'", () => {
    it("one 'source: host' warn line per environment, when the host first drops guest lines", () => {
        realPlatform();
        vi.spyOn(performance, 'now').mockImplementation(() => 1000);
        defineWebSandbox();
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const el = document.createElement('web-sandbox') as any;
        document.body.appendChild(el);
        el.setConfig({ mode: 'cooperative', capabilities: ['allow-scripts'] });
        const lines: any[] = [];
        el.addEventListener('sandbox-log', (event: CustomEvent) => lines.push(event.detail));
        const flood = () => {
            const { port1 } = new MessageChannel();
            el._port = port1;
            for (let i = 0; i < LOG_EVENTS_PER_SECOND + 50; i++) el._onGuestMessage(port1, () => {}, { type: 'LOG', level: 'log', args: [i] }, null);
            port1.close();
        };
        flood();
        const hostLines = () => lines.filter(line => line.source === 'host');
        expect(lines.filter(line => line.source === 'guest')).toHaveLength(LOG_EVENTS_PER_SECOND);
        expect(hostLines().map(line => [line.level, line.args[0]])).toEqual([
            ['warn', `[Sandbox] the guest logged more than ${LOG_EVENTS_PER_SECOND} lines in one second; lines past that rate are not dispatched as 'sandbox-log' events.`],
        ]);
        flood(); // the same environment: no second line
        expect(hostLines()).toHaveLength(1);
        el.reset(); // a new environment: its own line
        flood();
        expect(hostLines()).toHaveLength(2);
    });
});

describe('L-1: re-inserted from a terminated listener after a refused build, the element is terminated, not idle', () => {
    for (const [name, config] of [
        ["an old mode ('iframe')", { mode: 'iframe', capabilities: ['allow-scripts'] }],
        ['an unregistered entry', { mode: 'strict', entry: 'missing.js' }],
    ] as const) {
        it(name, async () => {
            realPlatform();
            defineWebSandbox();
            vi.spyOn(console, 'warn').mockImplementation(() => {});
            const el = document.createElement('web-sandbox') as any;
            const slot = document.createElement('div');
            document.body.append(el, slot);
            const events: string[] = [];
            el.addEventListener('ready', () => events.push('ready'));
            el.addEventListener('terminated', (event: CustomEvent) => {
                events.push(`terminated: ${event.detail.reason}`);
                slot.appendChild(el); // a move: disconnected, then connected
            });
            el.setConfig(config);
            await settle();
            await settle();
            expect([el.isConnected, el.state, el.shadowRoot.querySelector('iframe')]).toEqual([true, 'terminated', null]);
            expect(events).toHaveLength(1);
            expect(await outcome(el.call('anything'))).toMatchObject({ code: 'TERMINATED', message: expect.stringContaining('terminated') });
        });
    }
});

describe("L-2: a call whose arguments' getter ends the environment settles", () => {
    function loadingElement() {
        realPlatform();
        defineWebSandbox();
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const el = document.createElement('web-sandbox') as any;
        document.body.appendChild(el);
        el.setConfig({ mode: 'cooperative', capabilities: ['allow-scripts'] });
        expect(el.state).toBe('loading');
        return el;
    }

    for (const [name, end] of [
        ['terminate()', (el: any) => el.terminate()],
        ['remove()', (el: any) => el.remove()],
        ['reset()', (el: any) => el.reset()],
    ] as const) {
        it(`${name} in a getter: the call rejects TERMINATED and nothing is left queued`, async () => {
            const el = loadingElement();
            const call = el.callWithTimeout(0, 'echo', { get x() { end(el); return 1; } });
            expect(await outcome(call)).toMatchObject({ code: 'TERMINATED' });
            expect(el._queue).toEqual([]);
        });
    }

    it('positive control: a getter that ends nothing: the call is queued for this environment', async () => {
        const el = loadingElement();
        const call = el.callWithTimeout(0, 'echo', { get x() { return 1; } });
        expect(await outcome(call)).toBe('pending');
        expect(el._queue).toHaveLength(1);
        el.remove();
        expect(await outcome(call)).toMatchObject({ code: 'TERMINATED' });
    });
});

describe('C-4: the strict view bounds the guest error texts it relays before posting them', () => {
    const originalWorker = (globalThis as any).Worker;
    afterEach(() => {
        (globalThis as any).Worker = originalWorker;
        delete (globalThis as any).__sandboxViewRuns;
    });

    async function startView() {
        realPlatform();
        const workers: { onerror: ((event: unknown) => void) | null; transfer: MessagePort[] }[] = [];
        (globalThis as any).Worker = class {
            constructor() { workers.push(this as any); }
            onerror: unknown = null;
            transfer: MessagePort[] = [];
            postMessage(_message: unknown, transfer: MessagePort[]) { this.transfer = transfer; }
        };
        new Function(viewBootstrapSource(VIEW_OPTIONS))();
        const logic = new MessageChannel(), view = new MessageChannel();
        const toHost: any[] = [];
        view.port2.onmessage = (event) => toHost.push(event.data);
        window.dispatchEvent(new MessageEvent('message', { data: { type: 'INIT_VIEW', workerSource: 'void 0', entryDone: '__testEntryDone', viewFiles: [], html: '' }, source: window, ports: [logic.port1, view.port1] }));
        const worker = workers[0]!;
        const fail = (message: string) => worker.onerror!({ message, preventDefault() {} });
        const delivered = async () => {
            for (let i = 0; i < 20; i++) await new Promise(resolve => setTimeout(resolve, 5));
            return toHost.filter(frame => frame.type === 'GUEST_ERROR' || frame.type === 'GUEST_UNCAUGHT');
        };
        return { worker, fail, delivered, close: () => { view.port2.close(); logic.port2.close(); } };
    }

    it("the entry's error (GUEST_ERROR) is cut to 2048 characters in the view", async () => {
        const { fail, delivered, close } = await startView();
        fail('e'.repeat(2 ** 20));
        expect((await delivered()).map(frame => [frame.type, frame.message.length])).toEqual([['GUEST_ERROR', 2048]]);
        close();
    });

    it(`later errors (GUEST_UNCAUGHT) are cut too, and at most ${LOG_EVENTS_PER_SECOND} leave the view in any one second`, async () => {
        vi.spyOn(performance, 'now').mockImplementation(() => 1000);
        const { worker, fail, delivered, close } = await startView();
        const render = worker.transfer[1]!;
        render.postMessage({ type: 'VIEW_STARTED' });
        await new Promise(resolve => setTimeout(resolve, 20));
        fail('Uncaught Error: __testEntryDone'); // the marker error: the entry ran to its end (backlog S75)
        for (let i = 0; i < LOG_EVENTS_PER_SECOND + 100; i++) fail('u'.repeat(4096));
        const frames = await delivered();
        expect(frames).toHaveLength(LOG_EVENTS_PER_SECOND);
        expect(frames.every(frame => frame.type === 'GUEST_UNCAUGHT' && frame.message.length === 2048)).toBe(true);
        render.close();
        close();
    });
});

describe('M-4: a valid URL is reported in full in the fetch record, up to the URL limit', () => {
    it('a URL of 3000 characters is reported whole; a longer URL than 8192 is refused and reported cut to 8192', async () => {
        const records: FetchRecord[] = [];
        const bridge = createFetchBridge({
            policy: toFetchPolicy({ allow: ['https://api.example'] }, () => {})!,
            hostOrigin: 'https://host.example',
            onRecord: (record) => records.push(record),
            fetchImpl: async () => new Response('ok'),
        });
        const long = 'https://api.example/' + 'a'.repeat(3000);
        await bridge.handle({ url: long, method: 'GET' });
        // percent-encoding makes the parsed URL longer than the guest's string: it is checked as parsed
        const expanding = 'https://api.example/' + '"'.repeat(3000);
        await bridge.handle({ url: expanding, method: 'GET' }).catch(() => {});
        expect(records.map(record => [record.outcome, record.url.length])).toEqual([['ok', long.length], ['refused', 8192]]);
    });
});

describe("M-2: callLimits, the call budget's option (the owner's name)", () => {
    function element() {
        realPlatform();
        defineWebSandbox();
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const el = document.createElement('web-sandbox') as any;
        document.body.appendChild(el);
        const warnings = () => warn.mock.calls.map(call => String(call[0])).filter(message => message.includes('callLimits'));
        return { el, warnings };
    }
    const literal = (budget: { calls: number; bytes: number }) => `"callBudget":${JSON.stringify(budget)}`;

    it('the defaults: no callLimits, an empty one, or a field left out', () => {
        const { el, warnings } = element();
        for (const config of [{}, { callLimits: {} }, { callLimits: { maxPerSecond: undefined } }]) {
            el.setConfig({ mode: 'cooperative', capabilities: ['allow-scripts'], ...config });
            expect(el._callBudget).toEqual(CALL_BUDGET);
            expect(el._getSandboxCommsScript('cooperative', [])).toContain(literal(CALL_BUDGET));
        }
        el.setConfig({ mode: 'cooperative', capabilities: ['allow-scripts'], callLimits: { maxBytesPerSecond: 1024 } });
        expect(el._callBudget).toEqual({ calls: CALL_BUDGET.calls, bytes: 1024 });
        // a byte budget below the largest call is kept, and says once which calls it refuses (review round 5, L-2)
        expect(warnings()).toEqual(['[Sandbox] callLimits.maxBytesPerSecond is 1024, below the largest call (34603008 bytes): a call heavier than 1024 bytes is refused with ARGS_NOT_TRANSFERABLE.']);
    });

    it('a value that is not a finite number >= 1 takes its default, with one warning each (once per element); there is no "off"', () => {
        const { el, warnings } = element();
        const invalid = [Infinity, 0, -1, NaN, '10', null, true];
        for (const value of invalid) {
            el.setConfig({ mode: 'cooperative', capabilities: ['allow-scripts'], callLimits: { maxPerSecond: value, maxBytesPerSecond: value } });
            expect(el._callBudget, String(value)).toEqual(CALL_BUDGET);
            expect(el.state).toBe('loading'); // the config is used, the rest of it applies
        }
        expect(warnings()).toHaveLength(2 * invalid.length);
        expect(warnings()[0]).toBe('[Sandbox] callLimits.maxPerSecond must be a finite number >= 1; Infinity was ignored: the default 1000 applies.');
        el.setConfig({ mode: 'cooperative', capabilities: ['allow-scripts'], callLimits: { maxPerSecond: Infinity } });
        expect(warnings()).toHaveLength(2 * invalid.length); // the same message, said once
        for (const value of [5, 'off', [1]]) {
            el.setConfig({ mode: 'cooperative', capabilities: ['allow-scripts'], callLimits: value });
            expect(el._callBudget).toEqual(CALL_BUDGET);
        }
        expect(warnings().filter(message => message.startsWith('[Sandbox] callLimits must be an object'))).toHaveLength(3);
    });

    it('a custom value takes effect at both ends, in every mode: the host answers BUSY at its edge, and the bootstrap carries it', async () => {
        let now = 1000;
        vi.spyOn(performance, 'now').mockImplementation(() => now);
        const { el } = element();
        const custom = { calls: 3, bytes: 1_000_000 };
        el.setConfig({ mode: 'worker', callLimits: { maxPerSecond: 3, maxBytesPerSecond: 1_000_000 } });
        expect(el._getSandboxCommsScript('worker', [])).toContain(literal(custom));
        el.setConfig({ mode: 'strict', callLimits: { maxPerSecond: 3, maxBytesPerSecond: 1_000_000 } });
        expect(el._getStrictWorkerSource([], '')).toContain(literal(custom));
        el.setConfig({ mode: 'cooperative', capabilities: ['allow-scripts'], callLimits: { maxPerSecond: 3, maxBytesPerSecond: 1_000_000 } });
        const { port1 } = new MessageChannel();
        el._port = port1;
        const answers: any[] = [];
        el.expose('noop', () => 'ok');
        for (let i = 1; i <= 4; i++) el._onGuestMessage(port1, (answer: unknown) => answers.push(answer), request(i, 'noop'), null);
        await settle();
        expect(answers.map(answer => answer.code ?? answer.value)).toEqual(['BUSY', 'ok', 'ok', 'ok']); // BUSY at once, the others a microtask later
        expect(answers[0]).toMatchObject({ id: 4, error: 'more than 3 calls or 1000000 bytes of calls in one second' });
        now += 1000;
        el._onGuestMessage(port1, (answer: unknown) => answers.push(answer), request(5, 'noop'), null);
        await settle();
        expect(answers.at(-1)).toMatchObject({ id: 5, ok: true });
        port1.close();
    });

    it('a changed callLimits is a changed config: the same one rebuilds nothing, another rebuilds', () => {
        const { el } = element();
        const config = { mode: 'cooperative', capabilities: ['allow-scripts'], callLimits: { maxPerSecond: 10 } };
        el.setConfig(config);
        const frame = el.shadowRoot.querySelector('iframe');
        el.setConfig(structuredClone(config));
        expect(el.shadowRoot.querySelector('iframe')).toBe(frame);
        el.setConfig({ ...config, callLimits: { maxPerSecond: 11 } });
        expect(el.shadowRoot.querySelector('iframe')).not.toBe(frame);
        expect(el._callBudget.calls).toBe(11);
    });
});

describe("C-2 and M-5: the view's time budget charges only the rendering it measured after a flush", () => {
    // The view's frames and clock, driven by the test: requestAnimationFrame callbacks wait in `frames` until `frame()`
    // runs them (a hidden or off-screen view runs none), and performance.now() reads `clock.now`. Timers and the view's
    // own tasks are real.
    const originalWorker = (globalThis as any).Worker;
    const originalFrame = { request: window.requestAnimationFrame, cancel: window.cancelAnimationFrame };
    const clock = { now: 1000 };
    let frames = new Map<number, FrameRequestCallback>();
    let nextFrame = 1;
    afterEach(() => {
        (globalThis as any).Worker = originalWorker;
        window.requestAnimationFrame = originalFrame.request;
        window.cancelAnimationFrame = originalFrame.cancel;
        delete (globalThis as any).__sandboxViewRuns;
    });

    const frame = () => {
        const due = [...frames.values()];
        frames = new Map();
        for (const callback of due) callback(clock.now);
    };
    const tasks = () => new Promise(resolve => setTimeout(resolve, 5));
    const until = async (check: () => boolean, ms: number) => {
        const deadline = Date.now() + ms;
        while (!check() && Date.now() < deadline) await tasks();
        return check();
    };

    function startView() {
        realPlatform();
        clock.now = 1000;
        frames = new Map();
        vi.spyOn(performance, 'now').mockImplementation(() => clock.now);
        window.requestAnimationFrame = (callback: FrameRequestCallback) => { frames.set(nextFrame, callback); return nextFrame++; };
        window.cancelAnimationFrame = (id: number) => { frames.delete(id); };
        const workers: { transfer: MessagePort[] }[] = [];
        (globalThis as any).Worker = class {
            constructor() { workers.push(this as any); }
            onerror: unknown = null;
            transfer: MessagePort[] = [];
            postMessage(_message: unknown, transfer: MessagePort[]) { this.transfer = transfer; }
        };
        new Function(viewBootstrapSource(VIEW_OPTIONS))();
        const logic = new MessageChannel(), view = new MessageChannel();
        window.dispatchEvent(new MessageEvent('message', { data: { type: 'INIT_VIEW', workerSource: 'void 0', viewFiles: [], html: '<p id="a">0</p>', allowAnimations: true }, source: window, ports: [logic.port1, view.port1] }));
        const render = workers[0]!.transfer[1]!;
        const acks: unknown[] = [];
        render.onmessage = (event) => { if (event.data?.type === 'VIEW_ACK') acks.push(event.data); };
        render.postMessage({ type: 'VIEW_STARTED' });
        const send = (value: string) => render.postMessage({ type: 'VIEW_TEXT', into: 'a', text: value });
        const text = async (value: string) => {
            const before = acks.length;
            send(value);
            return until(() => acks.length > before, 30000);
        };
        const shown = () => document.getElementById('a')?.textContent;
        const fromView: string[] = []; // the types of what the view posts to the host
        view.port2.onmessage = (event) => fromView.push(event.data?.type);
        return { send, text, shown, fromView, close: () => { render.close(); view.port2.close(); logic.port2.close(); } };
    }

    // The view shows again: frames run every 16 ms of real time, and the clock follows.
    const runFrames = () => {
        const timer = setInterval(() => { clock.now += 16; frame(); }, 16);
        return () => clearInterval(timer);
    };

    it('hidden 5 s with a render applied meanwhile: the next render after showing applies at once (18.3 s at 16c545b)', { timeout: 60000 }, async () => {
        const { send, text, shown, close } = startView();
        await tasks();
        expect(await text('1')).toBe(true); // applied while hidden: by the timer that stands in for frames
        expect(shown()).toBe('1');
        clock.now += 5000; // hidden: no frame ran
        frame(); // shown: the frames the view waited for run
        clock.now += 5; // the rendering update they caused
        await tasks();
        const stop = runFrames();
        const started = Date.now();
        send('2');
        const ok = await until(() => shown() === '2', 1500);
        stop();
        expect(ok, `applied after ${Date.now() - started} ms`).toBe(true);
        close();
    });

    it('at most one measurement waits for a frame, however many flushes ran while no frame did', { timeout: 60000 }, async () => {
        const { text, close } = startView();
        await tasks();
        frame(); // the initial render's measurement
        await tasks();
        for (let i = 1; i <= 5; i++) expect(await text(String(i))).toBe(true); // hidden: each flushed by the timer
        expect(frames.size).toBe(1);
        close();
    });

    // Review round 5, M-2: the debt was floored at one second (VIEW_APPLY_MAX_DEBT_MS), so an operation of 7.5 s was
    // charged 1.2 s and ran again every 12.5 s. Each is charged in full now, and the second past VIEW_MAX_OPERATION_MS
    // within VIEW_OVERRUN_WINDOW_MS ends the sandbox (S72). (At 60814b5, the 1.5 s update held the next one back 5 s, and
    // 20 s did too.)
    it("a rendering update that took 1.5 s holds the next operation back for all of it: 1.3 s of debt, repaid at 200 ms per second (6.5 s)", { timeout: 60000 }, async () => {
        const { send, text, shown, fromView, close } = startView();
        await tasks();
        frame();
        await tasks();
        expect(await text('1')).toBe(true);
        frame(); // the frame that renders it
        clock.now += 1500; // its rendering update took 1.5 s (with the floor, the next operation waited 5 s)
        await tasks();
        const stop = runFrames();
        const started = Date.now();
        send('2');
        const ok = await until(() => shown() === '2', 15000);
        const waited = Date.now() - started;
        stop();
        expect(ok).toBe(true);
        expect(waited, '1.5 s less the 200 ms the budget held, at VIEW_APPLY_MS_PER_SECOND').toBeGreaterThan(6000);
        expect(fromView).not.toContain('VIEW_OVERRUN');
        close();
    });

    // Backlog S72 (class P), the repeated-overrun rule: one overrun is charged and survived; the second within
    // VIEW_OVERRUN_WINDOW_MS ends the view. (Before S72 the first ended it.)
    const count = (fromView: string[], type: string) => fromView.filter(t => t === type).length;
    for (const [later, ends] of [[0, true], [VIEW_OVERRUN_WINDOW_MS + 1, false]] as const) {
        it(`a rendering update past VIEW_MAX_OPERATION_MS (${VIEW_MAX_OPERATION_MS} ms) is a first overrun, and the view goes on once its debt is repaid; a second ${ends ? 'within the window ends the view: VIEW_OVERRUN, once, and nothing more is applied' : 'past the window is a first overrun again'}`, { timeout: 60000 }, async () => {
            const { send, text, shown, fromView, close } = startView();
            await tasks();
            frame();
            await tasks();
            expect(await text('1')).toBe(true);
            frame();
            clock.now += VIEW_MAX_OPERATION_MS + 1; // its rendering update took just past the limit
            await tasks();
            expect(count(fromView, 'VIEW_FIRST_OVERRUN')).toBe(1);
            expect(count(fromView, 'VIEW_OVERRUN')).toBe(0);
            clock.now += 10000 + later; // the 9 s of debt repaid (and, for the second case, the window passed)
            let stop = runFrames();
            send('2');
            expect(await until(() => shown() === '2', 1500)).toBe(true); // applied: the view went on
            stop();
            await tasks();
            expect(await text('3')).toBe(true);
            frame();
            clock.now += VIEW_MAX_OPERATION_MS + 1; // the second overrun
            await tasks();
            expect(count(fromView, 'VIEW_OVERRUN')).toBe(ends ? 1 : 0);
            expect(count(fromView, 'VIEW_FIRST_OVERRUN')).toBe(ends ? 1 : 2);
            if (ends) {
                clock.now += 20000;
                stop = runFrames();
                send('4');
                await until(() => shown() === '4', 1500);
                stop();
                expect(shown()).toBe('3');
                expect(count(fromView, 'VIEW_OVERRUN')).toBe(1);
            }
            close();
        });
    }

    it('at the limit, and hidden for 30 s between flushes: no VIEW_OVERRUN (time in which no frame ran is no operation)', { timeout: 60000 }, async () => {
        const { text, fromView, close } = startView();
        await tasks();
        frame();
        await tasks();
        expect(await text('1')).toBe(true);
        frame();
        clock.now += VIEW_MAX_OPERATION_MS; // exactly the limit: allowed
        await tasks();
        clock.now += 30000; // hidden: no frame
        expect(await text('2')).toBe(true); // flushed by the timer, measured by the next frame
        clock.now += 30000;
        frame();
        clock.now += 5;
        await tasks();
        expect(fromView).not.toContain('VIEW_OVERRUN');
        close();
    });

    it('a page hidden between the frame and the measure: the measure is dropped, neither charged nor counted', { timeout: 60000 }, async () => {
        const { send, text, shown, fromView, close } = startView();
        await tasks();
        frame();
        await tasks();
        expect(await text('1')).toBe(true);
        frame(); // the measure starts here
        clock.now += 60000; // the page was hidden and its timers throttled before the measure's task ran
        document.dispatchEvent(new Event('visibilitychange', { bubbles: true }));
        await tasks();
        expect(fromView).not.toContain('VIEW_OVERRUN');
        const stop = runFrames();
        send('2');
        const ok = await until(() => shown() === '2', 1500); // nothing was charged: applied at once
        stop();
        expect(ok).toBe(true);
        close();
    });
});
