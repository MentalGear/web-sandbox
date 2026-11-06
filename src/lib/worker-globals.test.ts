import { describe, expect, it } from 'vitest';
import { keepOnlyWorkerGlobals, STRICT_WORKER_GLOBALS, WORKER_GLOBALS, WORKER_NAVIGATOR_MEMBERS, WORKER_STATE_READS } from './worker-globals';

/**
 * The worker globals allowlist (VR:V1), on a stand-in global shaped like a worker's
 * (measured: interfaces own, the scope's attributes and operations on its prototypes). The e2e spec
 * (test/e2e/worker-globals-and-termination.spec.ts) runs it in real workers on Chromium, Firefox and WebKit.
 */

// The function as the worker gets it: stringified, run on a stand-in global.
const run = (g: object) => new Function(`return (${keepOnlyWorkerGlobals.toString()})`)()(g, WORKER_GLOBALS, WORKER_NAVIGATOR_MEMBERS);

function standInWorker() {
    class WorkerNavigator {}
    Object.defineProperty(WorkerNavigator.prototype, 'userAgent', { get: () => 'ua', configurable: true });
    Object.defineProperty(WorkerNavigator.prototype, 'serviceWorker', { get: () => ({}), configurable: true });
    class WorkerGlobalScope extends EventTarget {}
    for (const name of ['fetch', 'importScripts', 'fonts', 'caches', 'setTimeout', 'navigator']) {
        Object.defineProperty(WorkerGlobalScope.prototype, name, { value: name === 'navigator' ? new WorkerNavigator() : () => name, writable: true, configurable: true });
    }
    class DedicatedWorkerGlobalScope extends WorkerGlobalScope {}
    Object.defineProperty(DedicatedWorkerGlobalScope.prototype, 'TEMPORARY', { value: 0, configurable: false }); // a WebIDL constant (Chromium)
    Object.defineProperty(DedicatedWorkerGlobalScope.prototype, 'Dropped', { value: 1, configurable: true });
    const g = new DedicatedWorkerGlobalScope() as any;
    for (const name of ['EventSource', 'WebTransport', 'FontFace', 'Worker', 'SharedWorker', 'Notification', 'SomeFutureApi', 'WebSocket', 'XMLHttpRequest', 'Object', 'EventTarget']) {
        Object.defineProperty(g, name, { value: name === 'EventTarget' ? EventTarget : function () {}, writable: true, configurable: true });
    }
    Object.defineProperty(g, 'NaN', { value: NaN, configurable: false });
    return { g, scope: WorkerGlobalScope.prototype, dedicated: DedicatedWorkerGlobalScope.prototype, navigatorPrototype: WorkerNavigator.prototype };
}

describe('V1: the worker keeps only the allowlisted globals', () => {
    it('deletes every own and scope-prototype name off the list (EventSource, FontFace, fonts, caches, nested workers, a name nobody listed) and keeps the listed ones', () => {
        const { g, scope, dedicated, navigatorPrototype } = standInWorker();
        run(g);
        expect(Object.getOwnPropertyNames(g).sort()).toEqual(['EventTarget', 'NaN', 'Object', 'WebSocket', 'XMLHttpRequest']);
        expect(Object.getOwnPropertyNames(scope).sort()).toEqual(['constructor', 'fetch', 'importScripts', 'navigator', 'setTimeout']);
        expect(Object.getOwnPropertyNames(dedicated).sort()).toEqual(['TEMPORARY', 'constructor']); // a constant cannot be deleted, and requests nothing
        expect(Object.getOwnPropertyNames(navigatorPrototype).sort()).toEqual(['constructor', 'userAgent']);
    });

    it('fails closed: a name off the list that cannot be deleted throws, so nothing after it in the worker runs', () => {
        const { g } = standInWorker();
        Object.defineProperty(g, 'EventSource', { value: function () {}, configurable: false });
        expect(() => run(g)).toThrowError(/could not remove EventSource/);
        const other = standInWorker();
        Object.defineProperty(other.g, 'connection', { get: () => ({}), configurable: false });
        expect(() => run(other.g)).toThrowError(/could not remove connection/);
    });

    it('lists exactly four globals that can make a request: fetch, XMLHttpRequest, WebSocket, importScripts (each measured as governed on every engine)', () => {
        const NETWORK = ['fetch', 'XMLHttpRequest', 'WebSocket', 'importScripts', 'EventSource', 'WebTransport', 'WebSocketStream', 'FontFace', 'fonts', 'caches',
            'Cache', 'CacheStorage', 'Notification', 'Worker', 'SharedWorker', 'ServiceWorker', 'ServiceWorkerContainer', 'PushManager', 'BackgroundFetchManager',
            'RTCDataChannel', 'MediaSource', 'ReportingObserver', 'navigator.serviceWorker', 'navigator.sendBeacon'];
        const listed = [...WORKER_GLOBALS, ...WORKER_NAVIGATOR_MEMBERS.map(name => `navigator.${name}`)];
        expect(NETWORK.filter(name => listed.includes(name))).toEqual(['fetch', 'XMLHttpRequest', 'WebSocket', 'importScripts']);
        expect(new Set(WORKER_GLOBALS).size).toBe(WORKER_GLOBALS.length);
    });

    it("strict mode's list is the same without importScripts (its script-src is the view's hash, so importScripts() could load nothing), and the worker then has none", () => {
        expect(STRICT_WORKER_GLOBALS).toEqual(WORKER_GLOBALS.filter(name => name !== 'importScripts'));
        const { g, scope } = standInWorker();
        new Function(`return (${keepOnlyWorkerGlobals.toString()})`)()(g, STRICT_WORKER_GLOBALS, WORKER_NAVIGATOR_MEMBERS);
        expect(Object.getOwnPropertyNames(scope).sort()).toEqual(['constructor', 'fetch', 'navigator', 'setTimeout']);
        expect('importScripts' in g).toBe(false);
    });
});

// BD5:ISO-1, BD5:ISO-2 (class A, the host page's context; the allowlist is the chokepoint): a kept name that reads browser
// state keyed to an origin or to the profile can be answered from the host page's own record (WebKit's permissions were).
// Every such name is classified with what it reads (WORKER_STATE_READS); every other name of the allowlists was reviewed
// as reading none, and is listed below. A name added to the allowlists fails here until it is put in one of the two.
const REVIEWED_NO_STATE = `
    globalThis Infinity NaN undefined eval isFinite isNaN parseFloat parseInt decodeURI decodeURIComponent encodeURI encodeURIComponent
    escape unescape Object Function Array Number Boolean String Symbol BigInt RegExp Promise Proxy Reflect JSON Math Atomics Iterator
    Error AggregateError EvalError RangeError ReferenceError SyntaxError TypeError URIError SuppressedError InternalError
    ArrayBuffer SharedArrayBuffer DataView Int8Array Uint8Array Uint8ClampedArray Int16Array Uint16Array Int32Array Uint32Array Float16Array
    Float32Array Float64Array BigInt64Array BigUint64Array Map Set WeakMap WeakSet WeakRef FinalizationRegistry DisposableStack
    AsyncDisposableStack WebAssembly
    self navigator name close onerror onrejectionhandled onunhandledrejection onlanguagechange onoffline ononline setTimeout clearTimeout
    setInterval clearInterval queueMicrotask requestAnimationFrame cancelAnimationFrame structuredClone reportError atob btoa console crypto
    createImageBitmap scheduler DedicatedWorkerGlobalScope WorkerGlobalScope WorkerLocation WorkerNavigator
    fetch XMLHttpRequest XMLHttpRequestEventTarget XMLHttpRequestUpload WebSocket importScripts
    Request Response Headers FormData AbortController AbortSignal Event EventTarget CustomEvent ErrorEvent MessageEvent ProgressEvent
    PromiseRejectionEvent CloseEvent SecurityPolicyViolationEvent DOMException QuotaExceededError DOMStringList MessageChannel MessagePort
    Blob File FileList FileReader FileReaderSync URL URLSearchParams URLPattern TextDecoder TextEncoder TextDecoderStream TextEncoderStream
    CompressionStream DecompressionStream ReadableStream ReadableStreamDefaultReader ReadableStreamBYOBReader ReadableStreamBYOBRequest
    ReadableStreamDefaultController ReadableByteStreamController WritableStream WritableStreamDefaultWriter WritableStreamDefaultController
    TransformStream TransformStreamDefaultController ByteLengthQueuingStrategy CountQueuingStrategy Crypto CryptoKey SubtleCrypto
    IDBCursor IDBCursorWithValue IDBDatabase IDBIndex IDBKeyRange IDBObjectStore IDBOpenDBRequest IDBRecord IDBRequest IDBTransaction
    IDBVersionChangeEvent Scheduler TaskController TaskSignal TaskPriorityChangeEvent
    Performance PerformanceEntry PerformanceMark PerformanceMeasure PerformanceObserver PerformanceObserverEntryList PerformanceResourceTiming
    PerformanceServerTiming
    DOMMatrix DOMMatrixReadOnly DOMPoint DOMPointReadOnly DOMQuad DOMRect DOMRectReadOnly ImageData ImageBitmap ImageBitmapRenderingContext
    OffscreenCanvas OffscreenCanvasRenderingContext2D CanvasGradient CanvasPattern Path2D TextMetrics
    WebGLRenderingContext WebGL2RenderingContext WebGLActiveInfo WebGLBuffer WebGLContextEvent WebGLFramebuffer WebGLObject WebGLProgram
    WebGLQuery WebGLRenderbuffer WebGLSampler WebGLShader WebGLShaderPrecisionFormat WebGLSync WebGLTexture WebGLTransformFeedback
    WebGLUniformLocation WebGLVertexArrayObject
    AudioData AudioDecoder AudioEncoder EncodedAudioChunk EncodedVideoChunk VideoColorSpace VideoDecoder VideoEncoder VideoFrame
    ImageDecoder ImageTrack ImageTrackList
`.trim().split(/\s+/);

describe('the allowlists read no state of the host page: every name that reads origin- or profile-keyed state is classified (BD5:ISO-1)', () => {
    const listed = [...WORKER_GLOBALS, ...WORKER_NAVIGATOR_MEMBERS.map(name => `navigator.${name}`)];
    const classified = Object.keys(WORKER_STATE_READS);

    it('every name of the allowlists is either a classified state read or reviewed as reading none, never both', () => {
        const unreviewed = listed.filter(name => !classified.includes(name) && !REVIEWED_NO_STATE.includes(name));
        expect(unreviewed, 'classify each new name: in WORKER_STATE_READS with what it reads and its measured answer, or in this list if it reads no state').toEqual([]);
        expect(classified.filter(name => REVIEWED_NO_STATE.includes(name))).toEqual([]);
        expect(new Set(REVIEWED_NO_STATE).size).toBe(REVIEWED_NO_STATE.length);
    });

    it('every classified name and every reviewed one is on the allowlists (no stale entry), and each classification says why', () => {
        for (const name of [...classified, ...REVIEWED_NO_STATE]) expect(listed, name).toContain(name);
        for (const [name, why] of Object.entries(WORKER_STATE_READS)) expect(why.length, name).toBeGreaterThan(20);
    });

    it('every navigator member is classified: the navigator is where an engine answers from its per-origin or profile records', () => {
        for (const member of WORKER_NAVIGATOR_MEMBERS) expect(classified, member).toContain(`navigator.${member}`);
    });

    it("the permission API and the storage manager are not offered (WebKit answered permissions from the host origin's grants; Firefox's estimate() ended the task)", () => {
        for (const name of ['Permissions', 'PermissionStatus', 'StorageManager', 'navigator.permissions', 'navigator.storage']) expect(listed, name).not.toContain(name);
    });
});
