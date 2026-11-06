import { test, expect } from './fixture';

/**
 * What crosses a call is what the value and the API show (class P; rpc.ts, compactViews and handlerErrorText), in the
 * default mode (sealed: `setConfig({ entry })`, no `mode`), host to app and app to host, on every engine:
 *   1. a typed array or DataView that covers part of its buffer arrives with a buffer of exactly its bytes, at any
 *      depth, as a Map key or value or a Set member; two views of one buffer arrive with a buffer each; the Emscripten
 *      pattern (`HEAPU8.subarray(ptr, ptr + n)` of a 16 MiB module heap) sends n bytes (BD5:LIM-1);
 *   2. a host method that throws an engine error quoting the host's data, or returns a value clone cannot carry (whose
 *      Chromium error quotes the function's source), gives the app its name or the library's text only; the host's
 *      console has the engine's text (BD5:LIM-2, BD5:DOC-1).
 * unit tests: test/unit/rpc-what-crosses.test.ts; the property test over the posted snapshot: test/unit/structural.test.ts.
 */

const SECRET = 'HOSTSECRET42';

// The app: reads every case from the host, describes what arrived, calls the host's throwing methods, sends a partial
// view of its own, and reports all of it.
const ENTRY = `
const text = (b) => Array.from(new Uint8Array(b)).map(c => c ? String.fromCharCode(c) : '').join('');
const describe = (v) => {
  if (v instanceof Blob) return { kind: 'Blob', size: v.size };
  if (ArrayBuffer.isView(v)) return { kind: Object.prototype.toString.call(v).slice(8, -1), byteOffset: v.byteOffset, byteLength: v.byteLength, bufferLength: v.buffer.byteLength, whole: text(v.buffer) };
  if (v instanceof Map) return { kind: 'Map', entries: [...v].map(([k, x]) => [describe(k), describe(x)]) };
  if (v instanceof Set) return { kind: 'Set', values: [...v].map(x => describe(x)) };
  if (Array.isArray(v)) return { kind: 'Array', values: v.map(x => describe(x)), sameBuffer: v.length === 2 && ArrayBuffer.isView(v[0]) && ArrayBuffer.isView(v[1]) ? v[0].buffer === v[1].buffer : undefined };
  if (v && typeof v === 'object') return { kind: 'Object', values: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, describe(x)])) };
  return { kind: typeof v, v: String(v) };
};
bridge.expose('take', (v) => describe(v));
(async () => {
  const results = {};
  for (const label of await bridge.call('labels')) {
    try { results[label] = describe(await bridge.call('get', label)); } catch (e) { results[label] = { error: e.code, message: e.message }; }
  }
  const failures = {};
  for (const label of await bridge.call('failureLabels')) {
    try { failures[label] = { resolved: JSON.stringify(await bridge.call('fail', label)) }; } catch (e) { failures[label] = { error: e.code, message: e.message }; }
  }
  const own = new Uint8Array(32);
  own.set(new TextEncoder().encode('GUESTPUBguest-private-bytes'));
  const guestToHost = await bridge.call('echo', own.subarray(0, 8), { nested: [new DataView(own.buffer, 8, 4)] });
  await bridge.call('report', { results, failures, guestToHost });
})();
`;

type Described = { kind: string; byteOffset?: number; byteLength?: number; bufferLength?: number; whole?: string; values?: any; entries?: any; sameBuffer?: boolean; size?: number; error?: string; message?: string };

test('sealed mode: a view crosses with its own bytes only, and a host method\'s failure carries no engine text, both ways', async ({ sandbox, page, browserName }) => {
    void sandbox; // the fixture opens the harness page
    const warnings: string[] = [];
    page.on('console', (message) => { if (message.type() === 'warning') warnings.push(message.text()); });
    const report = await page.evaluate(async ({ entry, secret }) => {
        const s = document.querySelector('web-sandbox') as any;
        const buffer = new Uint8Array(64);
        buffer.set(new TextEncoder().encode(`PUB${secret}-token=abc123`));
        const doubles = new Float64Array(8);
        doubles[0] = 1.5;
        doubles[5] = 4242.4242;
        // shared memory without cross-origin isolation: SharedArrayBuffer is not a global on every engine, a shared
        // WebAssembly.Memory's buffer is one on all three
        const shared = new (WebAssembly as any).Memory({ initial: 1, maximum: 1, shared: true }).buffer as ArrayBuffer;
        new Uint8Array(shared).set([7, 8, 9]);
        const cases: Record<string, () => unknown> = {
            subarray: () => buffer.subarray(0, 3),
            dataView: () => new DataView(buffer.buffer, 0, 3),
            constructedView: () => new Uint8Array(buffer.buffer, 0, 3),
            nested: () => ({ a: [{ v: buffer.subarray(0, 3) }] }),
            mapKeyAndValue: () => new Map([[buffer.subarray(0, 3), buffer.subarray(3, 6)]]),
            setMember: () => new Set([buffer.subarray(0, 3)]),
            twoViewsOneBuffer: () => [buffer.subarray(0, 3), buffer.subarray(3, 6)],
            float64Subarray: () => doubles.subarray(0, 1),
            wholeView: () => new Uint8Array(buffer.buffer),
            sliceControl: () => buffer.slice(0, 3),
            blobSlice: () => new Blob([buffer]).slice(0, 3),
            // the Emscripten pattern: a result read out of a 16 MiB module heap as HEAPU8.subarray(ptr, ptr + len)
            wasmHeap: () => {
                const heap = new Uint8Array(new WebAssembly.Memory({ initial: 256 }).buffer);
                heap.set(new TextEncoder().encode(`OUT${secret}-OTHER-DOCUMENT`), 1024);
                return heap.subarray(1024, 1027);
            },
            sharedMemory: () => new Uint8Array(shared, 0, 2),
        };
        class StoreError extends Error {}
        const failures: Record<string, () => unknown> = {
            jsonParse: () => JSON.parse(secret),
            bigint: () => BigInt(secret),
            url: () => new URL(secret),
            propertyOfNull: () => (null as any)[secret],
            textDecoder: () => new TextDecoder(secret),
            regexp: () => new RegExp(`${secret}(`),
            selector: () => document.querySelector(`${secret}[`),
            typeError: () => { throw new TypeError(`expected a record, got ${secret}`); },
            subclass: () => { throw new StoreError(secret); },
            plainError: () => { throw new Error('save: expected at most 1000 todos'); },
            string: () => { throw 'save: bad todo'; },
            // a result clone cannot carry: on Chromium the clone's error quotes the function's source
            resultFunction: () => ({ user: 'a', refresh() { return 'HOSTSECRET42-in-source'; } }),
            resultNode: () => ({ element: document.body }),
        };
        s.registerFiles({ 'main.js': entry });
        s.expose('labels', () => Object.keys(cases));
        s.expose('failureLabels', () => Object.keys(failures));
        s.expose('get', (label: string) => cases[label]!());
        s.expose('fail', (label: string) => failures[label]!());
        s.expose('echo', (view: Uint8Array, nested: { nested: DataView[] }) => ({ byteLength: view.byteLength, bufferLength: view.buffer.byteLength, text: new TextDecoder().decode(view), nested: [nested.nested[0]!.byteLength, nested.nested[0]!.buffer.byteLength] }));
        const fromApp = new Promise(resolve => s.expose('report', (value: unknown) => resolve(value)));
        const settled = await whenSettled(x => x.setConfig({ entry: 'main.js' }));
        const takes: Record<string, unknown> = {};
        for (const label of ['subarray', 'nested', 'mapKeyAndValue', 'twoViewsOneBuffer', 'wasmHeap', 'sharedMemory']) {
            try { takes[label] = await s.call('take', cases[label]!()); } catch (e: any) { takes[label] = { error: e.code, message: e.message }; }
        }
        const app = await fromApp as { results: Record<string, Described>; failures: Record<string, Described & { resolved?: string }>; guestToHost: unknown };
        return { settled, takes, ...app, hostBufferAfter: new TextDecoder().decode(buffer.subarray(0, 15)) };
    }, { entry: ENTRY, secret: SECRET });

    expect(report.settled).toBe('ready');
    const own = (view: Described | undefined, bytes: number, text?: string) => {
        expect(view).toMatchObject({ byteOffset: 0, byteLength: bytes, bufferLength: bytes });
        if (text !== undefined) expect(view!.whole).toBe(text);
    };
    // host -> app: results
    const { results } = report;
    own(results.subarray, 3, 'PUB');
    own(results.constructedView, 3, 'PUB');
    expect(results.dataView).toMatchObject({ kind: 'DataView', bufferLength: 3, whole: 'PUB' });
    own(results.nested!.values.a.values[0].values.v, 3, 'PUB');
    own(results.mapKeyAndValue!.entries[0][0], 3, 'PUB');
    own(results.mapKeyAndValue!.entries[0][1], 3, 'HOS');
    own(results.setMember!.values[0], 3, 'PUB');
    expect(results.twoViewsOneBuffer!.sameBuffer).toBe(false);
    own(results.twoViewsOneBuffer!.values[0], 3, 'PUB');
    own(results.twoViewsOneBuffer!.values[1], 3, 'HOS');
    expect(results.float64Subarray).toMatchObject({ kind: 'Float64Array', byteLength: 8, bufferLength: 8 });
    expect(results.wholeView).toMatchObject({ byteLength: 64, bufferLength: 64 }); // a view of its whole buffer: as it is
    own(results.sliceControl, 3, 'PUB');
    expect(results.blobSlice).toEqual({ kind: 'Blob', size: 3 });
    own(results.wasmHeap, 3, 'OUT'); // 3 bytes, not the 16 MiB heap
    // ledger: shared-memory-view-clone
    if (browserName === 'webkit') own(results.sharedMemory, 2);
    else expect(results.sharedMemory).toEqual({ error: 'RESULT_NOT_TRANSFERABLE', message: 'result is not transferable: it holds a value structured clone cannot carry' });
    // host -> app: call() arguments
    own(report.takes.subarray as Described, 3, 'PUB');
    own((report.takes.nested as Described).values.a.values[0].values.v, 3, 'PUB');
    own((report.takes.mapKeyAndValue as Described).entries[0][0], 3, 'PUB');
    expect((report.takes.twoViewsOneBuffer as Described).sameBuffer).toBe(false);
    own(report.takes.wasmHeap as Described, 3, 'OUT');
    // ledger: shared-memory-view-clone
    if (browserName === 'webkit') own(report.takes.sharedMemory as Described, 2);
    else expect(report.takes.sharedMemory).toMatchObject({ error: 'ARGS_NOT_TRANSFERABLE' });
    // app -> host
    expect(report.guestToHost).toEqual({ byteLength: 8, bufferLength: 8, text: 'GUESTPUB', nested: [4, 4] });
    expect(report.hostBufferAfter).toBe(`PUB${SECRET}`); // only the snapshot was transferred

    // a host method's failure: the app has no text of the engine's, and none of the host's data
    expect(JSON.stringify(report.failures)).not.toContain(SECRET);
    const { failures } = report;
    expect(failures.jsonParse).toEqual({ error: 'HANDLER_ERROR', message: 'the method failed (SyntaxError)' });
    expect(failures.bigint).toEqual({ error: 'HANDLER_ERROR', message: 'the method failed (SyntaxError)' });
    expect(failures.url).toEqual({ error: 'HANDLER_ERROR', message: 'the method failed (TypeError)' });
    expect(failures.propertyOfNull).toEqual({ error: 'HANDLER_ERROR', message: 'the method failed (TypeError)' });
    expect(failures.textDecoder).toEqual({ error: 'HANDLER_ERROR', message: 'the method failed (RangeError)' });
    expect(failures.regexp).toEqual({ error: 'HANDLER_ERROR', message: 'the method failed (SyntaxError)' });
    expect(failures.selector).toEqual({ error: 'HANDLER_ERROR', message: 'the method failed (SyntaxError)' }); // a DOMException named SyntaxError
    expect(failures.typeError).toEqual({ error: 'HANDLER_ERROR', message: 'the method failed (TypeError)' });
    expect(failures.subclass).toEqual({ error: 'HANDLER_ERROR', message: 'the method failed (Error)' });
    expect(failures.plainError).toEqual({ error: 'HANDLER_ERROR', message: 'save: expected at most 1000 todos' });
    expect(failures.string).toEqual({ error: 'HANDLER_ERROR', message: 'save: bad todo' });
    for (const label of ['resultFunction', 'resultNode']) {
        expect(failures[label], label).toEqual({ error: 'RESULT_NOT_TRANSFERABLE', message: 'result is not transferable: it holds a value structured clone cannot carry' });
    }
    // the host's console has each withheld text, with the method's name: the embedder can still debug
    const withheld = warnings.filter(text => text.startsWith('[Sandbox] the host method "fail" failed'));
    expect(withheld).toHaveLength(11);
    expect(withheld.some(text => text.includes(SECRET))).toBe(true);
});
