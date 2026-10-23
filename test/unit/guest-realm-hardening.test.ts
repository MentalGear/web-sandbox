import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { inSandboxScript } from '@src/lib/in-sandbox-script';
import { createBroker } from '@src/lib/rpc';

/**
 * The bootstrap's own guarantees (library logic, run in jsdom): BR:CB2 (no global lookup on
 * the EXECUTE path) and the guest-realm hardening of BR:PD2 (keepalive), BR:PD4 (history traversal) and BR:PD6 (window.name).
 * The browsers decide whether the hardening closes the leak: test/e2e/guest-realm-hardening.spec.ts.
 *
 * The bootstrap's port primitives run against stand-ins installed as the platform's, as in in-sandbox-script.test.ts.
 * PD2's guard is installed once per realm and is not configurable, so this file's realm gets one recording fetch,
 * installed before the first bootstrap, and every test reads what reached it.
 */
class FakeEvent {
    stopImmediatePropagation() {}
}
class FakeMessageEvent extends FakeEvent {
    readonly isTrusted = true;
    constructor(private readonly init: { data?: unknown; ports?: unknown[]; source?: unknown }) { super(); }
    get data() { return this.init.data; }
    get ports() { return this.init.ports ?? []; }
    get source() { return this.init.source ?? null; }
}
class FakePort {
    posted: unknown[] = [];
    private handler: ((event: unknown) => void) | null = null;
    postMessage(frame: unknown) { this.posted.push(frame); }
    get onmessage() { return this.handler; }
    set onmessage(handler) { this.handler = handler; }
    deliver(data: unknown) { this.handler!(new FakeMessageEvent({ data })); }
}
class FakeMessageChannel {
    readonly port1 = new FakePort();
    readonly port2 = new FakePort();
}
const PLATFORM: Record<string, unknown> = { MessagePort: FakePort, MessageEvent: FakeMessageEvent, Event: FakeEvent, MessageChannel: FakeMessageChannel };
const originals: Record<string, unknown> = {};

const reached: Request[] = [];
const recordingFetch = (request: Request) => { reached.push(request); return Promise.resolve(new Response('ok')); };
const ORIGINAL_BACK = History.prototype.back; // before any bootstrap of this file ran
beforeAll(() => {
    Object.defineProperty(globalThis, 'fetch', { value: recordingFetch, writable: true, configurable: true });
});

const originalAddEventListener = globalThis.addEventListener;
let listeners: Record<string, Function> = {};
beforeEach(() => {
    for (const [name, value] of Object.entries(PLATFORM)) {
        originals[name] = (globalThis as any)[name];
        (globalThis as any)[name] = value;
    }
    listeners = {};
    (globalThis as any).addEventListener = (type: string, cb: Function) => { listeners[type] = cb; };
    vi.spyOn(window, 'postMessage').mockImplementation(() => {});
});
afterEach(() => {
    globalThis.addEventListener = originalAddEventListener;
    for (const name of Object.keys(PLATFORM)) (globalThis as any)[name] = originals[name];
    delete (globalThis as any).bridge;
    vi.restoreAllMocks();
});

const console_ = () => ({ log: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }) as unknown as Console;

// A worker-mode bootstrap with its port handed over, as the frame does.
function worker(scriptUnsafe = true): FakePort {
    inSandboxScript(scriptUnsafe, 'worker', console_(), createBroker);
    const port = new FakePort();
    listeners['message']!(new FakeMessageEvent({ data: { type: 'INIT_PORT' }, ports: [port] }));
    return port;
}

describe('CB2: the EXECUTE path looks up no global', () => {
    it('guest code replacing String, Function, Reflect, JSON, Object, Error and Array.prototype methods changes nothing: the embedder\'s code runs, as written', () => {
        const port = worker();
        // the helper itself uses only what it captured first: it replaces Array.prototype.push and getOwnPropertyDescriptor too
        const describe_ = Object.getOwnPropertyDescriptor;
        const define = Object.defineProperty;
        const saved: [object, string, PropertyDescriptor][] = [];
        const replace = (target: object, name: string, value: unknown) => {
            saved[saved.length] = [target, name, describe_(target, name)!];
            define(target, name, { value, writable: true, configurable: true });
        };
        const hijack = () => 'globalThis.__ranByGuest = true';
        try {
            // guest code, after the bootstrap
            replace(globalThis, 'String', hijack);
            replace(globalThis, 'Function', function () { return () => { (globalThis as any).__ranByGuest = true; }; });
            replace(globalThis, 'Reflect', { apply: () => { (globalThis as any).__ranByGuest = true; }, construct: () => () => { (globalThis as any).__ranByGuest = true; } });
            replace(globalThis, 'JSON', { stringify: hijack, parse: hijack });
            replace(globalThis, 'Error', function () { (globalThis as any).__ranByGuest = true; return {}; });
            replace(Object, 'getOwnPropertyDescriptor', () => { (globalThis as any).__ranByGuest = true; });
            for (const name of ['push', 'map', 'join', 'indexOf', 'includes', 'slice', 'forEach']) replace(Array.prototype, name, () => { (globalThis as any).__ranByGuest = true; });
            port.deliver({ type: 'EXECUTE', code: 'globalThis.__ranByEmbedder = (globalThis.__ranByEmbedder || 0) + 1' });
            port.deliver({ type: 'EXECUTE', code: { toString: hijack } }); // not a string: nothing runs, nothing converts it
        } finally {
            for (let i = saved.length - 1; i >= 0; i--) define(saved[i]![0], saved[i]![1], saved[i]![2]);
        }
        expect((globalThis as any).__ranByEmbedder).toBe(1);
        expect((globalThis as any).__ranByGuest).toBeUndefined();
        delete (globalThis as any).__ranByEmbedder;
    });

    it('with scriptUnsafe off, an EXECUTE frame is refused with one log line and nothing runs (control)', () => {
        const port = worker(false);
        port.posted.length = 0;
        port.deliver({ type: 'EXECUTE', code: 'globalThis.__ranByEmbedder = 1' });
        expect((globalThis as any).__ranByEmbedder).toBeUndefined();
        expect(port.posted).toEqual([{ type: 'LOG', level: 'error', args: ['Execution blocked: scriptUnsafe is false'] }]);
    });
});

describe('PD2: the guest realm\'s fetch refuses keepalive', () => {
    it('keepalive in the init, through a getter that answers twice, or in a Request: refused before the platform\'s fetch; a plain request reaches it (control)', async () => {
        // the gate of an earlier test's bootstrap is still the realm's fetch (not configurable, writable): the platform's again
        (globalThis as any).fetch = recordingFetch;
        inSandboxScript(false, 'cooperative', console_(), createBroker, { connect: ['https://a.example'] });
        reached.length = 0;
        // An init whose keepalive getter answers differently on each read: the guard reads it exactly once, through the
        // Request it builds, and sends that Request, so the answer it checked is the request that is made.
        const answering = (...answers: boolean[]) => { let read = 0; return { method: 'POST', body: 'x', get keepalive() { return answers[Math.min(read++, answers.length - 1)]; } } as RequestInit; };
        const refusals = [
            fetch('https://a.example/1', { keepalive: true, method: 'POST', body: 'x' }),
            fetch('https://a.example/2', answering(true, false)),
            fetch(new Request('https://a.example/3', { keepalive: true })),
        ];
        for (const refusal of refusals) await expect(refusal).rejects.toThrow(TypeError);
        await expect(fetch('https://a.example/4', answering(false, true))).resolves.toBeInstanceOf(Response);
        await expect(fetch('https://a.example/plain', { method: 'POST', body: 'x' })).resolves.toBeInstanceOf(Response);
        expect(reached.map(request => [request.url, request.keepalive])).toEqual([['https://a.example/4', false], ['https://a.example/plain', false]]);
        // still not configurable: guest code can wrap fetch, never remove the guard underneath
        expect(Object.getOwnPropertyDescriptor(globalThis, 'fetch')!.configurable).toBe(false);
    });
});

describe('PD4, PD6: history traversal and window.name in the guest realm', () => {
    it('history.back(), forward() and go() do nothing and cannot be put back; the Navigation API refuses traversal', async () => {
        const traversed: string[] = [];
        class Navigation { back() { traversed.push('back'); } forward() { traversed.push('forward'); } traverseTo(_key?: string) { traversed.push('traverseTo'); } }
        (globalThis as any).Navigation = Navigation;
        const original = ORIGINAL_BACK;
        inSandboxScript(false, 'cooperative', console_(), createBroker);
        for (const name of ['back', 'forward', 'go'] as const) {
            const descriptor = Object.getOwnPropertyDescriptor(History.prototype, name)!;
            expect([descriptor.configurable, descriptor.writable], name).toEqual([false, false]);
            expect(History.prototype[name]).not.toBe(original);
            expect(Reflect.defineProperty(History.prototype, name, { value: original })).toBe(false);
        }
        // every way the Navigation API traverses (BD1:TST-7), each refused with the same rejection, none reaching the platform's
        const navigation = new Navigation();
        for (const name of ['back', 'forward', 'traverseTo'] as const) {
            const descriptor = Object.getOwnPropertyDescriptor(Navigation.prototype, name)!;
            expect([descriptor.configurable, descriptor.writable], name).toEqual([false, false]);
            const result = (name === 'traverseTo' ? navigation.traverseTo('key') : navigation[name]()) as unknown as { committed: Promise<unknown>; finished: Promise<unknown> };
            await expect(result.committed, name).rejects.toMatchObject({ name: 'InvalidStateError' });
            await expect(result.finished, name).rejects.toMatchObject({ name: 'InvalidStateError' });
        }
        expect(traversed).toEqual([]);
        delete (globalThis as any).Navigation;
    });

    it('window.name reads "" and ignores writes: the platform\'s accessor is replaced (whether the frame\'s name stays is the browsers\', e2e)', () => {
        const platform = Object.getOwnPropertyDescriptor(globalThis, 'name');
        inSandboxScript(false, 'cooperative', console_(), createBroker);
        const replaced = Object.getOwnPropertyDescriptor(globalThis, 'name')!;
        expect(replaced.get).not.toBe(platform?.get);
        expect(replaced.set).not.toBe(platform?.set);
        replaced.set!.call(globalThis, 'host-target'); // what an assignment calls (vitest's jsdom teardown tracks plain assignments to globals)
        expect(window.name).toBe('');
    });

    it('a worker gets neither (it has no history and no name of a frame): only the fetch guard', () => {
        expect(() => worker()).not.toThrow();
    });
});
