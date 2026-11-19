// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSizeOf, SNAPSHOT_MEASURED_KINDS, SNAPSHOT_REFUSED_KINDS } from '@src/lib/structured-size';
import { createBroker, type RpcFrame } from '@src/lib/rpc';
import { LOG_MAX_BYTES, toLogDetail } from '@src/lib/sandbox-log';

/**
 * The kinds of value a snapshot holds, enumerated against the measure (structured-size.ts; I7, design 02 "No `Blob` or
 * `File` crosses from the guest"). The domain is every kind structured clone carries that this environment can make: a
 * sample of each row of SNAPSHOT_MEASURED_KINDS and SNAPSHOT_REFUSED_KINDS, and every typed array constructor the global
 * object has, found by its prototype chain. A measured kind measures finite alone and inside every container; a refused
 * kind measures Infinity with its own kind named, alone and at any depth of an array, an object, a Map's key or value and
 * a Set. Then each arrival of a guest value at the host's chokepoint (the host's broker and the host's reading of a log
 * line) is shown refusing a `Blob` and a `File` before anything is handed on. The node environment: its Blob and File
 * are the platform's.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const sizeOf = createSizeOf();
const tagOf = (value: unknown) => (typeof value === 'object' && value !== null ? Object.prototype.toString.call(value).slice(8, -1) : value === null ? 'null' : typeof value);

// Every typed array constructor of the global object: the subclasses of %TypedArray%, whatever the engine adds.
const TypedArray = Object.getPrototypeOf(Uint8Array);
const typedArrayNames = Object.getOwnPropertyNames(globalThis).filter(name => {
    const value = (globalThis as Record<string, unknown>)[name];
    return typeof value === 'function' && Object.getPrototypeOf(value) === TypedArray;
}).sort();

// One sample of each measured kind but the typed arrays, which are enumerated from the global object above.
const MEASURED_SAMPLES: Record<Exclude<(typeof SNAPSHOT_MEASURED_KINDS)[number], 'typed array'>, () => unknown> = {
    string: () => 'text',
    number: () => 1.5,
    boolean: () => true,
    bigint: () => 12n,
    undefined: () => undefined,
    null: () => null,
    Array: () => [1, 'two'],
    Object: () => ({ k: 'v' }),
    Map: () => new Map([['k', 'v']]),
    Set: () => new Set(['v']),
    Date: () => new Date(0),
    RegExp: () => /a+/g,
    ArrayBuffer: () => new ArrayBuffer(4),
    DataView: () => new DataView(new ArrayBuffer(4)),
    String: () => Object('boxed'),
    Number: () => Object(2),
    Boolean: () => Object(false),
    BigInt: () => Object(3n),
};

// One sample of each refused kind.
const REFUSED_SAMPLES: Record<keyof typeof SNAPSHOT_REFUSED_KINDS, () => unknown> = {
    Blob: () => new Blob(['<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'], { type: 'image/svg+xml' }),
    File: () => new File(['<p>x</p>'], 'report.html', { type: 'text/html' }),
    Error: () => new TypeError('t'),
    DOMException: () => new DOMException('d', 'DataCloneError'),
    SharedArrayBuffer: () => new SharedArrayBuffer(8),
};

// A value at every place a container holds one, the container's own key included.
const PLACES: [string, (value: unknown) => unknown][] = [
    ['alone', value => value],
    ['in an array', value => [1, value]],
    ['in an object', value => ({ a: { b: value } })],
    ['as a Map key', value => new Map([[value, 1]])],
    ['as a Map value', value => new Map([['k', value]])],
    ['in a Set', value => new Set([value])],
    ['deep', value => ({ list: [new Map([['k', new Set([[value]])]])] })],
];

describe('SNAPSHOT_MEASURED_KINDS and SNAPSHOT_REFUSED_KINDS: the measure against every kind of the domain (I7)', () => {
    it('every row has a sample and every sample a row; no kind is both measured and refused', () => {
        expect(Object.keys(MEASURED_SAMPLES).sort()).toEqual(SNAPSHOT_MEASURED_KINDS.filter(kind => kind !== 'typed array').sort());
        expect(Object.keys(REFUSED_SAMPLES).sort()).toEqual(Object.keys(SNAPSHOT_REFUSED_KINDS).sort());
        for (const kind of SNAPSHOT_MEASURED_KINDS) expect(Object.keys(SNAPSHOT_REFUSED_KINDS), kind).not.toContain(kind);
        expect(typedArrayNames.length).toBeGreaterThanOrEqual(11);
    });

    it('each sample is of the kind its row names', () => {
        for (const [kind, make] of Object.entries(MEASURED_SAMPLES)) expect(tagOf(structuredClone(make())), kind).toBe(kind);
        for (const [kind, make] of Object.entries(REFUSED_SAMPLES)) expect(tagOf(make()), kind).toBe(kind);
    });

    it('a measured kind, and every typed array of the environment, measures finite alone and at every place', () => {
        const samples: [string, () => unknown][] = [...Object.entries(MEASURED_SAMPLES), ...typedArrayNames.map((name): [string, () => unknown] => [name, () => new (globalThis as any)[name](2)])];
        for (const [kind, make] of samples) {
            for (const [place, put] of PLACES) {
                const snapshot = structuredClone(put(make()));
                const unsupported = { kind: '' };
                expect(sizeOf(snapshot, Infinity, undefined, unsupported), `${kind} ${place}`).toBeLessThan(Infinity);
                expect(unsupported.kind, `${kind} ${place}`).toBe('');
            }
        }
    });

    it('a refused kind measures Infinity at every place, under every limit, and the refusal names its kind', () => {
        for (const [kind, make] of Object.entries(REFUSED_SAMPLES)) {
            for (const [place, put] of PLACES) {
                for (const limit of [Infinity, 2 ** 30, LOG_MAX_BYTES]) {
                    const unsupported = { kind: '' };
                    expect(sizeOf(put(make()), limit, undefined, unsupported), `${kind} ${place}`).toBe(Infinity);
                    expect(unsupported.kind, `${kind} ${place}`).toBe(kind);
                }
            }
        }
    });

    it('docs/API.md says a Blob and a File are refused, and what to send instead', () => {
        const api = readFileSync(path.join(ROOT, 'docs/API.md'), 'utf8').replace(/\s+/g, ' ');
        expect(api).toContain('A `Blob` or a `File` from the guest is refused');
        expect(api).toContain('send its bytes (`Uint8Array`, `ArrayBuffer`)');
    });
});

// ---- Every arrival of a guest value at the host's chokepoint

const GUEST_BLOBS: [string, () => unknown][] = [
    ['a Blob', () => new Blob(['<p>x</p>'], { type: 'text/html' })],
    ['a File', () => new File(['x'], 'invoice.pdf.exe', { type: 'application/pdf' })],
    ['a Blob in an object', () => ({ attachment: new Blob(['x']) })],
    ['a File in an array', () => [1, new File(['x'], 'a.svg')]],
    ['a Blob in a Map', () => new Map([['k', new Blob(['x'])]])],
    ['a File as a Map key', () => new Map([[new File(['x'], 'k'), 1]])],
    ['a Blob in a Set', () => new Set([new Blob(['x'])])],
];

/** The host's broker as the element makes it: the measure, no timeout. Frames posted to the other side are recorded. */
function hostBroker() {
    const posted: RpcFrame[] = [];
    const broker = createBroker((frame) => { posted.push(frame); }, { timeoutMs: 0, sizeOf: createSizeOf() });
    return { broker, posted };
}

const settle = () => new Promise(resolve => setTimeout(resolve, 0));
const outcome = (promise: Promise<unknown>) => promise.then(value => ({ resolved: value }), (error: any) => ({ code: error?.code, message: String(error?.message) }));

describe("a Blob or a File from the guest reaches no code of the embedder's, at each arrival (I7)", () => {
    it.each(GUEST_BLOBS)("a host method's arguments: %s is answered ARGS_NOT_TRANSFERABLE and the method never runs", async (_, make) => {
        const { broker } = hostBroker();
        const seen: unknown[][] = [];
        broker.expose('save', (...args: unknown[]) => { seen.push(args); return 'saved'; });
        const replies: RpcFrame[] = [];
        broker.handleMessage({ type: 'RPC_REQ', id: 1, method: 'save', args: ['before', make()] }, (frame: RpcFrame) => { replies.push(frame); });
        await settle();
        expect(seen).toEqual([]);
        expect(replies).toHaveLength(1);
        expect(replies[0]).toMatchObject({ ok: false, code: 'ARGS_NOT_TRANSFERABLE' });
        expect((replies[0] as { error: string }).error).toMatch(/^the call holds an unsupported value: (Blob|File)$/);
    });

    it.each(GUEST_BLOBS)('the result of call(): %s rejects RESULT_NOT_TRANSFERABLE; the value is never resolved', async (_, make) => {
        const { broker, posted } = hostBroker();
        const call = broker.call('load');
        broker.handleMessage({ type: 'RPC_RES', id: (posted[0] as { id: number }).id, ok: true, value: make() });
        const settled = await outcome(call);
        expect(settled).toMatchObject({ code: 'RESULT_NOT_TRANSFERABLE' });
        expect((settled as { message: string }).message).toMatch(/unsupported value: (Blob|File)$/);
    });

    it.each(GUEST_BLOBS)("a log line's arguments: %s is replaced by the library's text, and the other arguments stay", (_, make) => {
        let dropped = 0;
        const detail = toLogDetail({ type: 'LOG', level: 'log', args: ['before', make(), 'after'] }, 'guest', () => { dropped++; });
        expect(detail.args[0]).toBe('before');
        expect(detail.args[1]).toMatch(/^\[Sandbox\] dropped: unsupported value: (Blob|File)$/);
        expect(detail.args[2]).toBe('after');
        expect(dropped).toBe(1);
    });

    it('the controls: the same values as bytes arrive, at each arrival', async () => {
        const bytes = () => ({ attachment: new TextEncoder().encode('<p>x</p>') });
        const { broker, posted } = hostBroker();
        const seen: unknown[][] = [];
        broker.expose('save', (...args: unknown[]) => { seen.push(args); return 'saved'; });
        broker.handleMessage({ type: 'RPC_REQ', id: 1, method: 'save', args: [bytes()] }, () => {});
        await settle();
        expect(seen).toHaveLength(1);
        const call = broker.call('load');
        broker.handleMessage({ type: 'RPC_RES', id: (posted[0] as { id: number }).id, ok: true, value: bytes() });
        expect(await outcome(call)).toEqual({ resolved: bytes() });
        expect(toLogDetail({ type: 'LOG', level: 'log', args: [bytes()] }, 'guest').args).toEqual([bytes()]);
    });
});
