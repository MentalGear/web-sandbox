import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineWebSandbox } from '@src/host';
import { createBroker, RPC_MAX_BYTES } from '@src/lib/rpc';
import { createSizeOf } from '@src/lib/structured-size';
import { inSandboxScript } from '@src/lib/in-sandbox-script';
import { inSandboxFiles } from '@src/lib/in-sandbox-files';
import { inSandboxView, inStrictWorker, RENDER_RULES, sanitizeRender, VIEW_OPTIONS, VIEW_STILL_PSEUDO_ELEMENTS, viewBootstrapSource } from '@src/lib/in-sandbox-view';
import { keepOnlyWorkerGlobals, WORKER_GLOBALS, WORKER_NAVIGATOR_MEMBERS } from '@src/lib/worker-globals';
import { workerBootstrap } from '@src/lib/worker-bootstrap';
import { createGuestWrites } from '@src/lib/guest-writes';
import { FileStore } from '@src/lib/files';
import { createFetchBridge, toFetchPolicy, type FetchRecord } from '@src/lib/fetch-bridge';
import { LOG_EVENTS_PER_SECOND } from '@src/lib/sandbox-log';
import { SyntaxKind, tokenize } from '../../scripts/js-tokens';

/**
 * Review round 4: each finding where the library's own logic decides, reproduced here first against the code it names
 * (each test failed at c7672bb). The findings where the browser decides are in test/e2e/review-round-4.spec.ts.
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

const logs = (el: HTMLElement) => {
    const heard: any[] = [];
    el.addEventListener('sandbox-log', (e) => heard.push((e as CustomEvent).detail));
    return heard;
};

const settle = () => new Promise(resolve => setTimeout(resolve, 0));

/** A broker whose frames are captured. */
function capturedBroker(options: Record<string, unknown> = {}) {
    const frames: any[] = [];
    const broker = createBroker((frame) => { frames.push(structuredClone(frame)); }, { timeoutMs: 0, sizeOf: createSizeOf(), ...options });
    return { broker, frames };
}

async function outcome(promise: Promise<unknown>): Promise<{ code: unknown; message: string } | 'resolved' | 'pending'> {
    const settled = promise.then(() => 'resolved' as const, (error: any) => ({ code: error?.code, message: String(error?.message) }));
    return Promise.race([settled, new Promise<'pending'>(resolve => setTimeout(() => resolve('pending'), 50))]);
}

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    document.body.replaceChildren();
});

describe("M-1: the worker's own postMessage is not a way out: the library's port is the only path to the frame or the view", () => {
    // A stand-in global shaped like a worker's: the scope's operations on its prototypes (measured on every engine).
    function standInWorker() {
        class WorkerGlobalScope extends EventTarget {}
        Object.defineProperty(WorkerGlobalScope.prototype, 'setTimeout', { value: () => 0, writable: true, configurable: true });
        class DedicatedWorkerGlobalScope extends WorkerGlobalScope {}
        const posted: unknown[] = [];
        for (const name of ['postMessage', 'onmessage', 'onmessageerror']) {
            const value = name === 'postMessage' ? function (this: unknown, message: unknown) { posted.push(message); } : null;
            Object.defineProperty(DedicatedWorkerGlobalScope.prototype, name, { value, writable: true, configurable: true });
        }
        const g = new DedicatedWorkerGlobalScope() as any;
        Object.defineProperty(g, 'EventTarget', { value: EventTarget, writable: true, configurable: true });
        return { g, posted, dedicated: DedicatedWorkerGlobalScope.prototype };
    }

    it('postMessage, onmessage and onmessageerror are off the allowlist, so they are gone before any other script runs', () => {
        for (const name of ['postMessage', 'onmessage', 'onmessageerror']) expect(WORKER_GLOBALS, name).not.toContain(name);
        const { g, dedicated } = standInWorker();
        new Function(`return (${keepOnlyWorkerGlobals.toString()})`)()(g, WORKER_GLOBALS, WORKER_NAVIGATOR_MEMBERS);
        for (const name of ['postMessage', 'onmessage', 'onmessageerror']) {
            expect(name in g, name).toBe(false);
            expect(Object.getOwnPropertyNames(dedicated), name).not.toContain(name);
        }
    });

    it("the allowlist statement hands the platform's postMessage to the bootstrap that asks for it, and to nothing else", () => {
        const { g, posted } = standInWorker();
        const post = new Function(`return (${keepOnlyWorkerGlobals.toString()})`)()(g, WORKER_GLOBALS, WORKER_NAVIGATOR_MEMBERS);
        expect(typeof post).toBe('function');
        Reflect.apply(post, g, [{ type: 'WORKER_STARTED' }]);
        expect(posted).toEqual([{ type: 'WORKER_STARTED' }]);
    });

    it("worker mode's bootstrap posts WORKER_STARTED through the function it was handed, never through the global", () => {
        const sent: unknown[] = [];
        const listeners: ((event: unknown) => void)[] = [];
        vi.stubGlobal('addEventListener', (type: string, listener: (event: unknown) => void) => { if (type === 'message') listeners.push(listener); });
        vi.stubGlobal('postMessage', () => { throw new Error('the global postMessage is gone in the worker'); });
        // a trusted message, as the worker's INIT_PORT is (the bootstrap reads it through the prototypes' getters)
        class TrustedEvent { readonly isTrusted = true; stopImmediatePropagation() {} }
        class TrustedMessageEvent extends TrustedEvent {
            constructor(private readonly init: { data: unknown; ports: unknown[] }) { super(); }
            get data() { return this.init.data; }
            get ports() { return this.init.ports; }
        }
        vi.stubGlobal('Event', TrustedEvent);
        vi.stubGlobal('MessageEvent', TrustedMessageEvent);
        const comms = inSandboxScript(false, 'worker', new Proxy({}, { get: () => () => {} }) as Console, createBroker, { callBudget: { calls: 1000, bytes: 67108864 } }, createSizeOf, (message: unknown) => sent.push(message));
        expect(comms).toBeTruthy();
        vi.unstubAllGlobals();
        const { port1 } = new MessageChannel();
        for (const listener of listeners) listener(new TrustedMessageEvent({ data: { type: 'INIT_PORT' }, ports: [port1] }));
        expect(sent).toEqual([{ type: 'WORKER_STARTED' }]);
        port1.close();
    });

    it("worker mode's frame stops listening to the worker once it announced the port: a later message from the worker is not read", () => {
        const workers: any[] = [];
        vi.stubGlobal('Worker', class {
            onmessage: ((event: unknown) => void) | null = null;
            onerror: unknown = null;
            constructor() { workers.push(this); }
            postMessage() {}
        });
        const announced: unknown[] = [];
        vi.stubGlobal('parent', { parent: { postMessage: (message: unknown) => announced.push(message) } });
        workerBootstrap('void 0');
        const worker = workers[0];
        worker.onmessage({ data: { type: 'WORKER_STARTED' } });
        expect(announced).toEqual([{ type: 'SANDBOX_PORT' }]);
        expect(worker.onmessage).toBeNull();
    });
});

describe('C-1: a guest-controlled value is read once before it is posted, and every refusal text is a string', () => {
    it("a handler's error whose message answers a string first and an object after is posted as that string", async () => {
        const { broker, frames } = capturedBroker();
        let reads = 0;
        broker.expose('m', () => { throw { get message() { reads++; return reads === 1 ? 'small' : { length: 0, payload: 'x'.repeat(1 << 20) }; } }; });
        broker.handleMessage({ type: 'RPC_REQ', id: 1, method: 'm', args: [] });
        await settle();
        expect(frames).toEqual([{ type: 'RPC_RES', id: 1, ok: false, error: 'small', code: 'HANDLER_ERROR' }]);
        expect(reads).toBe(1);
    });

    it('anything thrown that is not a string becomes one, cut: an object whose message is not a string, a value whose String() throws', async () => {
        const { broker, frames } = capturedBroker();
        broker.expose('a', () => { throw { message: { length: 3 }, toString: () => 'y'.repeat(1 << 20) }; });
        broker.expose('b', () => { throw { message: 1, toString() { throw new Error('no'); } }; });
        broker.handleMessage({ type: 'RPC_REQ', id: 1, method: 'a', args: [] });
        broker.handleMessage({ type: 'RPC_REQ', id: 2, method: 'b', args: [] });
        await settle();
        expect(frames.map(frame => [typeof frame.error, frame.error.length <= 65536])).toEqual([['string', true], ['string', true]]);
    });

    it('a refusal frame (ok: false) that arrives past the byte budget is not handed over: a fixed text, RESULT_NOT_TRANSFERABLE', async () => {
        const { broker, frames } = capturedBroker();
        const call = broker.call('m');
        broker.handleMessage({ type: 'RPC_RES', id: frames[0].id, ok: false, error: 'boom', code: 'HANDLER_ERROR', extra: new Uint8Array(RPC_MAX_BYTES) });
        expect(await outcome(call)).toEqual({ code: 'RESULT_NOT_TRANSFERABLE', message: `the answer is larger than the RPC byte budget (${RPC_MAX_BYTES})` });
    });

    it('the source: no guest-realm function checks the type of a property and then reads it again in the same statement', () => {
        // The class of C-1: `typeof x.p === 'string' ? use(x.p) : …` reads x.p twice, and a getter answers each read as it
        // likes. Every function that runs in a guest realm or reads a guest's value before posting it is scanned.
        const sources: [string, string][] = [
            ['createBroker', createBroker.toString()],
            ['inSandboxScript', inSandboxScript.toString()],
            ['inSandboxFiles', inSandboxFiles.toString()],
            ['inStrictWorker', inStrictWorker.toString()],
            ['inSandboxView', inSandboxView.toString()],
            ['sanitizeRender', sanitizeRender.toString()],
        ];
        const offenders: string[] = [];
        for (const [name, source] of sources) {
            const tokens = tokenize(source);
            // statements, roughly: runs of tokens between `;`, `{` and `}`
            let start = 0;
            for (let i = 0; i <= tokens.length; i++) {
                const kind = tokens[i]?.kind;
                if (i < tokens.length && kind !== SyntaxKind.SemicolonToken && kind !== SyntaxKind.OpenBraceToken && kind !== SyntaxKind.CloseBraceToken) continue;
                const statement = tokens.slice(start, i);
                start = i + 1;
                for (let t = 0; t + 3 < statement.length; t++) {
                    if (statement[t]!.kind !== SyntaxKind.TypeOfKeyword) continue;
                    // typeof <identifier>(.<identifier>)+ : the chain, then every later occurrence of it in the statement
                    let end = t + 2;
                    while (end + 1 < statement.length && statement[end]!.kind === SyntaxKind.DotToken && statement[end + 1]!.kind === SyntaxKind.Identifier) end += 2;
                    if (end === t + 2) continue;
                    const chain = statement.slice(t + 1, end).map(token => token.text).join('');
                    const rest = statement.slice(end).map(token => token.text).join(' ');
                    const spaced = statement.slice(t + 1, end).map(token => token.text).join(' ');
                    if (rest.includes(spaced) && !rest.includes(spaced + ' (')) offenders.push(`${name}: ${chain}`);
                }
            }
        }
        expect(offenders).toEqual([]);
    });
});

describe('C-5: an inbound request whose arguments cannot be carried is answered ARGS_NOT_TRANSFERABLE, which is not retryable', () => {
    it('arguments holding a kind the measure does not know (an Error, an ImageData-like object) or past the byte budget: ARGS_NOT_TRANSFERABLE; the method does not run', async () => {
        const { broker, frames } = capturedBroker();
        const method = vi.fn(() => 'ran');
        broker.expose('m', method);
        broker.handleMessage({ type: 'RPC_REQ', id: 1, method: 'm', args: [new Error('x')] });
        broker.handleMessage({ type: 'RPC_REQ', id: 2, method: 'm', args: [new Uint8Array(RPC_MAX_BYTES)] });
        await settle();
        expect(method).not.toHaveBeenCalled();
        expect(frames.map(frame => [frame.id, frame.code, frame.error])).toEqual([
            [1, 'ARGS_NOT_TRANSFERABLE', 'the call holds an unsupported value: Error'],
            [2, 'ARGS_NOT_TRANSFERABLE', `the call is larger than the RPC byte budget (${RPC_MAX_BYTES})`],
        ]);
    });

    it('the caller rejects with ARGS_NOT_TRANSFERABLE when the other side reports it (no longer read as HANDLER_ERROR); local-only codes still are', async () => {
        const { broker, frames } = capturedBroker();
        const first = broker.call('m');
        const second = broker.call('m');
        broker.handleMessage({ type: 'RPC_RES', id: frames[0].id, ok: false, error: 'the call holds an unsupported value: Error', code: 'ARGS_NOT_TRANSFERABLE' });
        broker.handleMessage({ type: 'RPC_RES', id: frames[1].id, ok: false, error: 'x', code: 'TERMINATED' });
        expect(await outcome(first)).toEqual({ code: 'ARGS_NOT_TRANSFERABLE', message: 'the call holds an unsupported value: Error' });
        expect(await outcome(second)).toEqual({ code: 'HANDLER_ERROR', message: 'x' });
    });
});

describe('C-6: a callLimits value below 1 takes the default, with the warning', () => {
    it.each([0.5, 0.001, Number.MIN_VALUE])('%s', (value) => {
        const { el, warn } = element();
        el.setConfig({ mode: 'cooperative', capabilities: ['allow-scripts'], callLimits: { maxPerSecond: value, maxBytesPerSecond: value } });
        expect(el._callBudget).toEqual({ calls: 1000, bytes: 67108864 });
        const warnings = warn.mock.calls.map(call => String(call[0])).filter(message => message.includes('callLimits'));
        expect(warnings).toEqual([
            `[Sandbox] callLimits.maxPerSecond must be a finite number >= 1; ${value} was ignored: the default 1000 applies.`,
            `[Sandbox] callLimits.maxBytesPerSecond must be a finite number >= 1; ${value} was ignored: the default 67108864 applies.`,
        ]);
    });

    it('1 is a budget of one call per second (the edge)', () => {
        const { el } = element();
        el.setConfig({ mode: 'cooperative', capabilities: ['allow-scripts'], callLimits: { maxPerSecond: 1, maxBytesPerSecond: 1 } });
        expect(el._callBudget).toEqual({ calls: 1, bytes: 1 });
    });
});

describe('M-6: the default call budget is 1000 calls and 64 MiB per second', () => {
    it('the element, and the literal both ends take', () => {
        const { el } = element();
        el.setConfig({ mode: 'cooperative', capabilities: ['allow-scripts'] });
        expect(el._callBudget).toEqual({ calls: 1000, bytes: 67108864 });
        expect(el._getSandboxCommsScript('cooperative', [])).toContain('"callBudget":{"calls":1000,"bytes":67108864}');
    });
});

describe('C-8: the fetch record does not parse a URL longer than MAX_URL', () => {
    it('a refused URL of 1 MiB is reported cut to 8192 characters without being parsed', async () => {
        const NativeURL = URL;
        let longParses = 0;
        vi.stubGlobal('URL', class extends NativeURL {
            constructor(input: string | URL, base?: string | URL) {
                if (typeof input === 'string' && input.length > 8192) longParses++;
                super(input, base);
            }
        });
        const records: FetchRecord[] = [];
        const bridge = createFetchBridge({ policy: toFetchPolicy({ allow: ['https://api.example'] }, () => {})!, hostOrigin: 'https://host.example', onRecord: (record) => records.push(record), fetchImpl: async () => new Response('ok') });
        await bridge.handle({ url: 'https://api.example/' + 'a'.repeat(1 << 20) }).catch(() => {});
        expect(records.map(record => [record.outcome, record.url.length])).toEqual([['refused', 8192]]);
        expect(longParses).toBe(0);
    });
});

describe("L-2: a listener of the first of an entry failure's two events that ends the environment hears no second one", () => {
    it.each([
        ['reset()', (el: any) => el.reset()],
        ['remove()', (el: any) => el.remove()],
        ["terminate('mine')", (el: any) => el.terminate('mine')],
    ])('%s', async (_name, act) => {
        const { el } = element();
        el.setConfig({ mode: 'strict' });
        const { port1: view } = new MessageChannel();
        el._viewPort = view;
        const heard = logs(el);
        el.addEventListener('sandbox-log', (e: CustomEvent) => { if (e.detail.source === 'host') act(el); }, { once: true });
        el._onViewMessage(view, { type: 'GUEST_ERROR', message: 'SyntaxError' });
        await settle();
        expect(heard.map(detail => [detail.source, detail.args[0]])).toEqual([['host', '[Sandbox] the guest entry failed to start']]);
        view.close();
    });

    it('without such a listener both lines arrive, host first (positive control)', async () => {
        const { el } = element();
        el.setConfig({ mode: 'strict' });
        const { port1: view } = new MessageChannel();
        el._viewPort = view;
        const heard = logs(el);
        el._onViewMessage(view, { type: 'GUEST_ERROR', message: 'SyntaxError' });
        expect(heard.map(detail => [detail.source, detail.args[0]])).toEqual([['host', '[Sandbox] the guest entry failed to start'], ['guest', 'Uncaught SyntaxError']]);
        view.close();
    });
});

describe("L-3: one rule for every 'terminated': a rebuild from its listener that gives the same answer is not dispatched again", () => {
    it("terminate(reason) whose reason a rebuild from the listener repeats: one 'terminated'", async () => {
        const { el } = element();
        el.registerFiles({ 'agent.js': 'void 0' });
        el.setConfig({ mode: 'strict', entry: 'agent.js' });
        el.unregisterFiles(['agent.js']);
        const reason = 'the guest entry "agent.js" is not a registered JavaScript file';
        const heard: string[] = [];
        el.addEventListener('terminated', (e: CustomEvent) => { heard.push(e.detail.reason); el.reset(); });
        el.terminate(reason);
        for (let i = 0; i < 5; i++) await settle();
        expect(heard).toEqual([reason]);
        expect(el.state).toBe('terminated');
    });

    it('a listener that changes what decides the answer builds normally (positive control)', async () => {
        const { el } = element();
        el.registerFiles({ 'agent.js': 'void 0' });
        el.setConfig({ mode: 'strict', entry: 'agent.js' });
        const heard: string[] = [];
        el.addEventListener('terminated', (e: CustomEvent) => { heard.push(e.detail.reason); el.reset(); }, { once: true });
        el.terminate('the guest entry "agent.js" is not a registered JavaScript file');
        await settle();
        expect(el.state).toBe('loading');
        expect(heard).toHaveLength(1);
    });
});

describe('L-4: a guest removal is announced only when it is listed', () => {
    it('the overlay: a removal of a path the host unregistered after the build records nothing that list() would drop', () => {
        const store = new FileStore();
        store.register({ 'agent.js': 'void 0', 'pic.png': new Uint8Array([1]) });
        const built = store.copy();
        const writes = createGuestWrites({ store, built });
        store.unregister(['pic.png']);
        const answer = writes.handle({ change: 'remove', path: 'pic.png' });
        expect(answer).toEqual({ path: 'pic.png', change: 'remove' }); // the guest's own view drops it
        expect(writes.change('pic.png')).toBeUndefined();
        expect(writes.list()).toEqual([]);
    });

    it("the element: no 'fileswritten' for it, and listGuestWrites() is empty; a removal of a stored path is announced and listed (positive control)", async () => {
        const { el } = element();
        el.registerFiles({ 'agent.js': 'void 0', 'pic.png': new Uint8Array([1]), 'keep.png': new Uint8Array([2]) });
        el.setConfig({ mode: 'cooperative', capabilities: ['allow-scripts'], guestWrites: true });
        el.unregisterFiles(['pic.png']);
        const announced: string[][] = [];
        el.addEventListener('fileswritten', (e: CustomEvent) => announced.push([...e.detail.paths]));
        await el._handleGuestWrite(el._guestWrites, { change: 'remove', path: 'pic.png' });
        expect([announced, el.listGuestWrites()]).toEqual([[], []]);
        await el._handleGuestWrite(el._guestWrites, { change: 'remove', path: 'keep.png' });
        expect([announced, el.listGuestWrites()]).toEqual([[['keep.png']], [{ path: 'keep.png', change: 'remove' }]]);
    });
});

describe("M-4: the strict view's error lines are cut once composed", () => {
    it.each(['GUEST_ERROR', 'GUEST_UNCAUGHT'])('%s: the guest line is at most 2048 characters, "Uncaught " included', (type) => {
        const { el } = element();
        el.setConfig({ mode: 'strict' });
        const { port1: view } = new MessageChannel();
        el._viewPort = view;
        const heard = logs(el);
        el._onViewMessage(view, { type, message: 'm'.repeat(2048) });
        const line = heard.find(detail => detail.source === 'guest')!.args[0] as string;
        expect([line.length, line.startsWith('Uncaught mmm')]).toEqual([2048, true]);
        view.close();
    });
});

describe("M-5: the view's guest-error rate limit says so the first time it drops", () => {
    const originalWorker = (globalThis as any).Worker;
    afterEach(() => {
        (globalThis as any).Worker = originalWorker;
        delete (globalThis as any).__sandboxViewRuns;
    });

    it(`past ${LOG_EVENTS_PER_SECOND} in one second: one GUEST_TEXT_DROPPED notice, once`, async () => {
        vi.spyOn(performance, 'now').mockImplementation(() => 1000);
        const workers: any[] = [];
        (globalThis as any).Worker = class {
            constructor() { workers.push(this); }
            onerror: unknown = null;
            transfer: MessagePort[] = [];
            postMessage(_message: unknown, transfer: MessagePort[]) { this.transfer = transfer; }
        };
        new Function(viewBootstrapSource(VIEW_OPTIONS))();
        const logic = new MessageChannel(), view = new MessageChannel();
        const toHost: any[] = [];
        view.port2.onmessage = (event) => toHost.push(event.data);
        window.dispatchEvent(new MessageEvent('message', { data: { type: 'INIT_VIEW', workerSource: 'void 0', viewFiles: [], html: '' }, source: window, ports: [logic.port1, view.port1] }));
        const worker = workers[0]!;
        const render = worker.transfer[1]!;
        render.postMessage({ type: 'VIEW_STARTED', entryErrors: 0 });
        await new Promise(resolve => setTimeout(resolve, 20));
        for (let i = 0; i < 2 * LOG_EVENTS_PER_SECOND; i++) worker.onerror({ message: 'u', preventDefault() {} });
        for (let i = 0; i < 20; i++) await new Promise(resolve => setTimeout(resolve, 5));
        const types = toHost.map(frame => frame.type).filter(type => type === 'GUEST_UNCAUGHT' || type === 'GUEST_TEXT_DROPPED');
        expect(types.filter(type => type === 'GUEST_UNCAUGHT')).toHaveLength(LOG_EVENTS_PER_SECOND);
        expect(types.filter(type => type === 'GUEST_TEXT_DROPPED')).toHaveLength(1);
        expect(types.indexOf('GUEST_TEXT_DROPPED')).toBe(LOG_EVENTS_PER_SECOND);
        render.close();
        view.port2.close();
        logic.port2.close();
    });

    it('the host turns the notice into one warn line per environment, labelled as the guest relay\'s own', () => {
        const { el } = element();
        el.setConfig({ mode: 'strict' });
        const { port1: view } = new MessageChannel();
        el._viewPort = view;
        const heard = logs(el);
        el._onViewMessage(view, { type: 'GUEST_TEXT_DROPPED' });
        el._onViewMessage(view, { type: 'GUEST_TEXT_DROPPED' });
        expect(heard.map(detail => [detail.source, detail.level, detail.args[0]])).toEqual([
            ['guest', 'warn', `[Sandbox] the guest raised more than ${LOG_EVENTS_PER_SECOND} uncaught errors in one second that only the view could describe; errors past that are dropped in the view.`],
        ]);
        view.close();
    });
});

describe('M-2: the renderer drops every URL the view policy refuses, reports it, and counts the URLs it keeps', () => {
    const run = (html: string, origins: Record<string, string[]>, room?: { elements: number; depth: number; urls?: number }, target = 'body') => {
        const template = document.createElement('template');
        template.innerHTML = html;
        const context = { target, animating: [] as string[], origins, refused: [] as [string, string][], urls: 0, loads: [] as string[] };
        sanitizeRender(template.content, () => null, () => false, RENDER_RULES, { animations: true, autoplay: true, stylesheets: true }, room, context);
        return { fragment: template.content, context };
    };
    const attribute = (fragment: DocumentFragment, id: string, name: string) => fragment.getElementById(id)!.getAttribute(name);

    it('by the kind of load each attribute makes: images (src, srcset, poster, a <picture> source), media (audio, video, their source and track)', () => {
        const { fragment, context } = run([
            '<img id="a" src="https://a.example/1.png"><img id="b" src="https://u:p@b.example:8443/2.png?q#f"><img id="c" srcset="https://a.example/3.png 1x, https://b.example/4.png 2x">',
            '<video id="v" src="https://b.example/v.mp4" poster="https://a.example/p.png"><source id="vs" src="https://a.example/s.mp4"><track id="t" src="https://b.example/t.vtt"></video>',
            '<picture><source id="ps" srcset="https://b.example/p.png"><img alt="x"></picture><div><source id="loose" src="https://b.example/l.mp4"></div>',
            '<img id="up" src="http://a.example/5.png"><img id="rel" src="r.png"><audio id="au" src="https://a.example/a.mp3"></audio>',
        ].join(''), { images: ['https://a.example'], media: ['https://b.example'] });
        expect([['a', 'src'], ['b', 'src'], ['c', 'srcset'], ['v', 'src'], ['v', 'poster'], ['vs', 'src'], ['t', 'src'], ['ps', 'srcset'], ['loose', 'src'], ['up', 'src'], ['rel', 'src'], ['au', 'src']].map(([id, name]) => attribute(fragment, id!, name!))).toEqual([
            'https://a.example/1.png', null, null, 'https://b.example/v.mp4', 'https://a.example/p.png', null, 'https://b.example/t.vtt', null, 'https://b.example/l.mp4', 'http://a.example/5.png', 'r.png', null,
        ]);
        expect(context.refused).toEqual([
            ['img-src', 'https://b.example:8443/2.png?q'],
            ['img-src', 'https://b.example/4.png'],
            ['media-src', 'https://a.example/s.mp4'],
            ['img-src', 'https://b.example/p.png'],
            ['media-src', 'https://a.example/a.mp3'],
        ]);
        expect(context.urls).toBe(7); // a, v src, v poster, t, loose (a <source> outside media loads nothing), up, rel
    });

    it("a fragment's top-level <source> loads by the target it goes into", () => {
        expect(run('<source id="s" src="https://b.example/s.mp4">', {}, undefined, 'video').context.refused).toEqual([['media-src', 'https://b.example/s.mp4']]);
        expect(run('<source id="s" src="https://b.example/s.mp4">', {}, undefined, 'div').context.refused).toEqual([]);
    });

    it('past what is left of VIEW_MAX_URLS it throws before anything is inserted; up to it, it does not', () => {
        expect(() => run('<img src="x"><img src="y">', {}, { elements: 10, depth: 10, urls: 2 })).not.toThrow();
        expect(() => run('<img src="x"><img src="y"><img src="z">', {}, { elements: 10, depth: 10, urls: 2 })).toThrowError('VIEW_MAX_URLS');
        expect(() => run('<img src="x"><img alt="no URL">', {}, { elements: 10, depth: 10, urls: 1 })).not.toThrow();
    });
});

describe('C-7: the still stylesheet names the volume control parts of the media controls', () => {
    it.each(['-webkit-media-controls-volume-control-container', '-webkit-media-controls-volume-control-hover-background'])('%s', (name) => {
        expect(VIEW_STILL_PSEUDO_ELEMENTS as readonly string[]).toContain(name);
    });
});

describe('the docs say what the code does', () => {
    it('C-3: ADR-006 says the record URL is the whole URL up to MAX_URL', () => {
        const adr = read('docs/ADR-006-fetch-bridge.md');
        expect(adr).not.toMatch(/the URL to 2048/);
        expect(adr).toMatch(/up to `MAX_URL` \(8192 characters/);
    });

    it("C-4: allowAnimations and allowAutoplay: left out or true keeps the default's side; the docs say exactly which values turn each off", () => {
        const host = read('src/host.ts');
        const api = read('docs/API.md');
        for (const text of [host, api]) {
            expect(text).not.toMatch(/Only a literal `false` turns them off; any other value that is not a boolean is taken as `false`/);
        }
    });

    it("M-3: the README's residuals of one operation name Chromium's <img> cost", () => {
        expect(read('README.md').replace(/\s+/g, ' ')).toContain('`<img>` elements in Chromium, which cost far more than their markup (6 500 `<img alt>` with no source: 1.9–2.6 s; Firefox and WebKit about 150 ms)');
    });

    it('I-1: API.md says an aborted record of a torn-down environment can arrive after reset(), while the next build loads', () => {
        expect(read('docs/API.md').replace(/\s+/g, ' ')).toContain('an `aborted` record of an environment that `reset()`, `load()` or `setConfig()` tore down can arrive after that call, while the next build is loading');
    });

    it("I-2: API.md's events table qualifies the fetch event by fetchBridge", () => {
        expect(read('docs/API.md')).toMatch(/^\| `fetch` \| `FetchRecord` \| yes \| With `fetchBridge`: /m);
    });

    it('I-2: the backlog does not say the guest has no sandboxFetch without the bridge', () => {
        expect(read('docs/BACKLOG.md')).not.toContain('the guest has no `sandboxFetch`');
    });
});
