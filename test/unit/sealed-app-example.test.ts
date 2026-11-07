import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// a plain JavaScript file: the embedder's side of the example, quoted by docs/API.md
import { mountTodoApp, pushAll } from '../../examples/sealed-app/host.js';

/**
 * The host side of examples/sealed-app/ (docs/API.md#building-an-app-in-sealed-mode), run against stub elements: what it
 * registers, how it configures the sandbox, that its `save` method, the one the docs hold up as the validation example
 * for an exposed method, takes only what it expects, and that every mount makes an element of its own which stop() ends
 * (BD6:LIM-2, BD6:CHL-3). The app itself runs in test/e2e/sealed-app.spec.ts, on three engines.
 */

const BUNDLE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../examples/sealed-app');

type Method = (...args: unknown[]) => unknown;
interface Stub {
    element: HTMLElement;
    methods: Map<string, Method>;
    calls: unknown[][];
    registered: Record<string, unknown>[];
    configs: Record<string, unknown>[];
    log: string[];
}

/** The elements `document.createElement('web-sandbox')` hands out, in order, each a plain element with the API stubbed. */
let stubs: Stub[] = [];
let loadFails: ((stub: Stub) => Error | null) | null = null;

function stubElements() {
    vi.restoreAllMocks(); // one spy at a time: a second mount of a test must not wrap the first
    const real = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
        if (tag !== 'web-sandbox') return real(tag);
        const element = real('div');
        const stub: Stub = { element, methods: new Map(), calls: [], registered: [], configs: [], log: [] };
        Object.assign(element, {
            registerFiles: (files: Record<string, unknown>) => stub.registered.push(files),
            expose: (name: string, fn: Method) => stub.methods.set(name, fn),
            setConfig: (config: Record<string, unknown>) => stub.configs.push(config),
            terminate: () => void stub.log.push('terminate'),
            call: async (...args: unknown[]) => {
                stub.calls.push(args);
                const failure = loadFails?.(stub);
                if (failure) throw failure;
            },
        });
        stubs.push(stub);
        return element;
    });
}

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    stubs = [];
    loadFails = null;
});

function stubFetch(failOn: string | null = null) {
    vi.stubGlobal('fetch', async (url: string) => {
        if (failOn !== null && url.endsWith(failOn)) throw new TypeError('network down');
        const bytes = readFileSync(path.join(BUNDLE, path.basename(url)));
        return { text: async () => bytes.toString('utf8'), arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
    });
}

function newStore(saved: string | null = null, appId = 'a') {
    const data = new Map<string, string>(saved === null ? [] : [[`todos:${appId}`, saved]]);
    return { data, getItem: (key: string) => data.get(key) ?? null, setItem: async (key: string, value: string) => void data.set(key, value) };
}

async function mount(saved: string | null = null, appId = 'a', store = newStore(saved, appId)) {
    stubElements();
    stubFetch();
    const container = document.createElement('section');
    const app = await mountTodoApp(container, { bundle: '/saved-app', appId, store });
    const stub = stubs[stubs.length - 1]!;
    return { ...stub, ...app, container, store, data: store.data, stub };
}

describe("the example's host side", () => {
    it('makes its own element in the container, registers the bundle, configures a sealed sandbox with guest writes, and hands the app its saved state', async () => {
        const { registered, configs, calls, container, sandbox, element } = await mount(JSON.stringify([{ text: 'milk', done: true }]));
        expect(sandbox).toBe(element);
        expect(container.contains(element), 'the element is in the container').toBe(true);
        const files = readdirSync(BUNDLE).filter(name => name !== 'host.js' && name !== 'app.html');
        expect(Object.keys(registered[0]!).sort(), 'every file of the bundle but the markup and this module is registered').toEqual(files.sort());
        expect(configs).toEqual([{ entry: 'app.js', html: readFileSync(path.join(BUNDLE, 'app.html'), 'utf8'), guestWrites: true }]); // no mode: sealed; no origins, no fetchBridge
        expect(calls).toEqual([['load', [{ text: 'milk', done: true }]]]);
    });

    it('starts empty when nothing is saved', async () => {
        expect((await mount()).calls).toEqual([['load', []]]);
    });

    it("save() keeps a copy of what it expects, and nothing the app adds", async () => {
        const { methods, data } = await mount();
        const hostile = JSON.parse('[{"text":"a","done":true,"__proto__":{"polluted":1},"extra":"x"}]');
        await methods.get('save')!(hostile);
        expect(data.get('todos:a')).toBe('[{"text":"a","done":true}]');
        expect(({} as any).polluted).toBeUndefined();
    });

    it('save() refuses what is not a list of todos of a bounded size, and stores nothing', async () => {
        const { methods, data } = await mount();
        const save = methods.get('save')!;
        const bad: unknown[] = [
            null, undefined, 'todos', 5, {}, { length: 1, 0: { text: 'a', done: true } },
            Array.from({ length: 1001 }, () => ({ text: 'a', done: false })),
            [null], [5], ['a'], [{}], [{ text: 'a' }], [{ done: true }], [{ text: 5, done: true }], [{ text: 'a', done: 'yes' }], [{ text: 'a', done: 1 }],
            [{ text: 'a'.repeat(201), done: false }],
            [{ text: 'fine', done: false }, { text: ['a'], done: false }],
        ];
        for (const value of bad) await expect(Promise.resolve().then(() => save(value)), JSON.stringify(value)?.slice(0, 40)).rejects.toThrow(/^save: /);
        expect(data.size).toBe(0);
        await expect(Promise.resolve(save(Array.from({ length: 1000 }, () => ({ text: 'a'.repeat(200), done: false }))))).resolves.toBeUndefined();
    });

    it('save() refuses a sparse array, which cannot store holes (BD6:DOC-1)', async () => {
        const { methods, data } = await mount();
        const save = methods.get('save')!;
        const holey = [{ text: 'a', done: false }, , { text: 'c', done: true }]; // eslint-disable-line no-sparse-arrays
        await expect(Promise.resolve().then(() => save(holey))).rejects.toThrow(/^save: bad todo/);
        const sparse: unknown[] = [];
        sparse[5] = { text: 'a', done: false };
        await expect(Promise.resolve().then(() => save(sparse))).rejects.toThrow(/^save: bad todo/);
        expect(data.size, 'nothing with a hole was stored').toBe(0);
    });

    it("each app's state is kept under its own id: another appId is handed none of it, and its save leaves the first untouched (BD5:CHL-1)", async () => {
        const first = await mount(JSON.stringify([{ text: 'PIN 4711', done: false }]), 'a');
        expect(first.calls).toEqual([['load', [{ text: 'PIN 4711', done: false }]]]);
        // a second app in the same store, under its own id, on an element of its own
        const second = await mount(null, 'b', first.store);
        expect(second.calls, 'the second app loads nothing of the first').toEqual([['load', []]]);
        await second.methods.get('save')!([{ text: 'by b', done: true }]);
        expect(first.data.get('todos:a')).toBe('[{"text":"PIN 4711","done":false}]');
        expect(first.data.get('todos:b')).toBe('[{"text":"by b","done":true}]');
        expect(first.data.has('todos')).toBe(false); // no fixed key
    });

    it('each mount makes a new element: two mounts never share one, whatever their order or overlap (BD6:LIM-2)', async () => {
        stubElements();
        stubFetch();
        const container = document.createElement('section');
        let release!: () => void;
        const gate = new Promise<void>((resolve) => (release = resolve));
        const slow = { ...newStore(JSON.stringify([{ text: 'A-PRIVATE', done: false }]), 'a'), getItem: async () => { await gate; return JSON.stringify([{ text: 'A-PRIVATE', done: false }]); } };
        const first = mountTodoApp(container, { bundle: '/saved-app', appId: 'a', store: slow });
        const second = await mountTodoApp(container, { bundle: '/saved-app', appId: 'b', store: newStore() });
        release();
        const firstApp = await first;
        expect(firstApp.sandbox).not.toBe(second.sandbox);
        const [forFirst, forSecond] = [stubs[0]!, stubs[1]!];
        expect(forSecond.calls, 'the second element is sent nothing of the first app').toEqual([['load', []]]);
        expect(forFirst.calls).toEqual([['load', [{ text: 'A-PRIVATE', done: false }]]]);
    });

    it('stop() terminates the element and removes it, and a save that started before it writes nothing (BD5:DOC-3, BD6:LIM-2)', async () => {
        const { methods, data, stop, log, container, element } = await mount(JSON.stringify([{ text: 'milk', done: false }]));
        const save = methods.get('save')!;
        stop();
        expect(log).toEqual(['terminate']);
        expect(container.contains(element), 'the element is gone from the page').toBe(false);
        // the handler was already running: its write is the embedder's own code, and the flag stops it
        await save([{ text: 'zombie', done: true }]);
        expect(data.get('todos:a')).toBe('[{"text":"milk","done":false}]');
    });

    it('a mount that fails stops itself and rethrows: no element is left, whatever step failed (BD6:CHL-3)', async () => {
        for (const step of ['load', 'fetch']) {
            stubs = [];
            stubElements();
            stubFetch(step === 'fetch' ? 'logo.png' : null);
            loadFails = step === 'load' ? () => new Error('load failed') : null;
            const container = document.createElement('section');
            await expect(mountTodoApp(container, { bundle: '/saved-app', appId: 'a', store: newStore() }), step).rejects.toThrow(step === 'load' ? 'load failed' : 'network down');
            expect(container.children.length, `${step}: the failed mount's element is removed`).toBe(0);
            expect(stubs[0]!.log, `${step}: terminated`).toEqual(['terminate']);
            vi.restoreAllMocks();
        }
    });

    it('a store that fails stops the mount too', async () => {
        stubElements();
        stubFetch();
        const container = document.createElement('section');
        const store = { getItem: () => { throw new Error('store down'); }, setItem: async () => {} };
        await expect(mountTodoApp(container, { bundle: '/saved-app', appId: 'a', store })).rejects.toThrow('store down');
        expect(container.children.length).toBe(0);
        expect(stubs[0]!.log).toEqual(['terminate']);
    });

    it('pushAll() sends the stream in batches, one call after the other', async () => {
        const order: string[] = [];
        let open = 0;
        const sandbox = { call: async (method: string, batch: unknown[]) => { open++; expect(open).toBe(1); order.push(`${method}:${batch.length}`); await Promise.resolve(); open--; } };
        await pushAll(sandbox, Array.from({ length: 120 }, () => ({ text: 'a', done: false })));
        expect(order).toEqual(['push:50', 'push:50', 'push:20']);
    });
});
