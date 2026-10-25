import { describe, expect, it, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// a plain JavaScript file: the embedder's side of the example, quoted by docs/API.md
import { mountTodoApp, pushAll } from '../../examples/sealed-app/host.js';

/**
 * The host side of examples/sealed-app/ (docs/API.md#building-an-app-in-sealed-mode), run against a stub element: what it
 * registers, how it configures the sandbox, and that its `save` method, the one the docs hold up as the validation example
 * for an exposed method, takes only what it expects. The app itself runs in test/e2e/sealed-app.spec.ts, on three engines.
 */

const BUNDLE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../examples/sealed-app');

async function mount(saved: string | null = null) {
    vi.stubGlobal('fetch', async (url: string) => {
        const bytes = readFileSync(path.join(BUNDLE, path.basename(url)));
        return { text: async () => bytes.toString('utf8'), arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
    });
    const methods = new Map<string, (...args: unknown[]) => unknown>();
    const calls: unknown[][] = [];
    const registered: Record<string, unknown>[] = [];
    const configs: Record<string, unknown>[] = [];
    const sandbox = {
        registerFiles: (files: Record<string, unknown>) => registered.push(files),
        expose: (name: string, fn: (...args: unknown[]) => unknown) => methods.set(name, fn),
        setConfig: (config: Record<string, unknown>) => configs.push(config),
        call: async (...args: unknown[]) => { calls.push(args); },
    };
    const data = new Map<string, string>(saved === null ? [] : [['todos', saved]]);
    const store = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => void data.set(key, value) };
    await mountTodoApp(sandbox, { bundle: '/saved-app', store });
    return { methods, calls, registered, configs, data };
}

describe("the example's host side", () => {
    it('registers the bundle, configures a sealed sandbox with guest writes, and hands the app its saved state', async () => {
        const { registered, configs, calls } = await mount(JSON.stringify([{ text: 'milk', done: true }]));
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
        methods.get('save')!(hostile);
        expect(data.get('todos')).toBe('[{"text":"a","done":true}]');
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
        for (const value of bad) expect(() => save(value), JSON.stringify(value)?.slice(0, 40)).toThrow(/^save: /);
        expect(data.has('todos')).toBe(false);
        expect(() => save(Array.from({ length: 1000 }, () => ({ text: 'a'.repeat(200), done: false })))).not.toThrow();
    });

    it('pushAll() sends the stream in batches, one call after the other', async () => {
        const order: string[] = [];
        let open = 0;
        const sandbox = { call: async (method: string, batch: unknown[]) => { open++; expect(open).toBe(1); order.push(`${method}:${batch.length}`); await Promise.resolve(); open--; } };
        await pushAll(sandbox, Array.from({ length: 120 }, () => ({ text: 'a', done: false })));
        expect(order).toEqual(['push:50', 'push:50', 'push:20']);
    });
});
