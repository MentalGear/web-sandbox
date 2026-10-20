/**
 * What guest code may find on a worker's global object, in worker mode and in strict mode (VR:V1; ADR-005 G4 amendment).
 *
 * Why an allowlist. A worker inherits its creator's policy, and connect-src is meant to govern every request it
 * makes, but an engine can miss one of its network APIs: Firefox (146) sent `new EventSource(url)` from a worker to
 * an origin connect-src blocks, and loaded `new FontFace(name, 'url(…)')` past font-src, with no violation — while
 * fetch, XMLHttpRequest, WebSocket and importScripts from the same worker were refused, and EventSource in the
 * document was refused. A denylist of such APIs would have to know every engine's gaps and every future API. So the
 * worker keeps only the globals listed here, and the prelude deletes every other name before any guest code runs.
 * A name that is not listed is gone, whatever it is; a new platform API stays out until someone lists it.
 *
 * The globals that can make a request at all are four, each measured as governed by the policy on Chromium, Firefox
 * and WebKit (test/e2e/verification.spec.ts, "V1"): fetch and XMLHttpRequest and WebSocket (connect-src) and
 * importScripts (script-src). Everything else listed makes no request: the language's built-ins, timers, events,
 * messaging inside the worker, encoding, streams, crypto, blobs and URLs, IndexedDB, canvas and WebGL on an
 * OffscreenCanvas (no URL), WebCodecs (bytes in, frames out), performance and scheduling. WebAssembly's streaming
 * compilation reads a Response the guest's fetch already made. `Request`, `Response` and `Headers` are values, and
 * `BroadcastChannel` reaches only the guest's own opaque origin.
 *
 * Deliberately absent (they request, or exist to): EventSource, WebTransport, WebSocketStream, FontFace and `fonts`,
 * `caches`, Notification (its icon), the Service Worker and Push interfaces, nested Worker and SharedWorker (a realm
 * this prelude never reaches), the RTC interfaces, MediaSource, BackgroundFetch, Reporting. On the navigator:
 * `serviceWorker` and `connection`.
 *
 * Absent too, the worker's own channel to its parent (R4:M-1): `postMessage`, `onmessage` and
 * `onmessageerror`. A dedicated worker's postMessage reaches the Worker object in the document that made it (worker
 * mode's hidden frame, strict mode's view), and that document runs on the host page's thread in Firefox and WebKit:
 * every message is deserialized there, outside every budget the library keeps (measured with four 8 MiB messages per
 * timer tick: Firefox's host page 77% busy, WebKit's 30–42%). The library's own MessagePort, behind the bootstrap's
 * budgets, is the only path from the worker to its parent. The bootstrap of worker mode needs the platform's postMessage
 * once, to tell its frame it runs (WORKER_STARTED): keepOnlyWorkerGlobals hands it the function it found, read before
 * anything is deleted, and nothing else in the worker can reach it. Strict mode's prelude needs none. Messages INTO the
 * worker (INIT_PORT, INIT_WORKER) still arrive: they are `message` events on the global, which the bootstraps listen to
 * with addEventListener.
 */
export const WORKER_GLOBALS: readonly string[] = [
    // ECMAScript
    'globalThis', 'Infinity', 'NaN', 'undefined', 'eval', 'isFinite', 'isNaN', 'parseFloat', 'parseInt',
    'decodeURI', 'decodeURIComponent', 'encodeURI', 'encodeURIComponent', 'escape', 'unescape',
    'Object', 'Function', 'Array', 'Number', 'Boolean', 'String', 'Symbol', 'BigInt', 'Date', 'RegExp', 'Promise',
    'Proxy', 'Reflect', 'JSON', 'Math', 'Intl', 'Atomics', 'Iterator', 'Temporal',
    'Error', 'AggregateError', 'EvalError', 'RangeError', 'ReferenceError', 'SyntaxError', 'TypeError', 'URIError',
    'SuppressedError', 'InternalError',
    'ArrayBuffer', 'SharedArrayBuffer', 'DataView', 'Int8Array', 'Uint8Array', 'Uint8ClampedArray', 'Int16Array',
    'Uint16Array', 'Int32Array', 'Uint32Array', 'Float16Array', 'Float32Array', 'Float64Array', 'BigInt64Array',
    'BigUint64Array', 'Map', 'Set', 'WeakMap', 'WeakSet', 'WeakRef', 'FinalizationRegistry', 'DisposableStack',
    'AsyncDisposableStack', 'WebAssembly',
    // the worker's own scope: identity, timers, errors (no postMessage, onmessage or onmessageerror: above)
    'self', 'location', 'navigator', 'origin', 'isSecureContext', 'crossOriginIsolated', 'name', 'close',
    'onerror', 'onrejectionhandled', 'onunhandledrejection',
    'onlanguagechange', 'onoffline', 'ononline', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
    'queueMicrotask', 'requestAnimationFrame', 'cancelAnimationFrame', 'structuredClone', 'reportError', 'atob', 'btoa',
    'console', 'performance', 'crypto', 'indexedDB', 'createImageBitmap', 'scheduler',
    'DedicatedWorkerGlobalScope', 'WorkerGlobalScope', 'WorkerLocation', 'WorkerNavigator',
    // the four that request, each governed by the policy on every engine (measured)
    'fetch', 'XMLHttpRequest', 'XMLHttpRequestEventTarget', 'XMLHttpRequestUpload', 'WebSocket', 'importScripts',
    // values and events
    'Request', 'Response', 'Headers', 'FormData', 'AbortController', 'AbortSignal', 'Event', 'EventTarget',
    'CustomEvent', 'ErrorEvent', 'MessageEvent', 'ProgressEvent', 'PromiseRejectionEvent', 'CloseEvent',
    'SecurityPolicyViolationEvent', 'DOMException', 'QuotaExceededError', 'DOMStringList',
    'MessageChannel', 'MessagePort', 'BroadcastChannel',
    // bytes, text, streams, URLs, crypto
    'Blob', 'File', 'FileList', 'FileReader', 'FileReaderSync', 'URL', 'URLSearchParams', 'URLPattern',
    'TextDecoder', 'TextEncoder', 'TextDecoderStream', 'TextEncoderStream', 'CompressionStream', 'DecompressionStream',
    'ReadableStream', 'ReadableStreamDefaultReader', 'ReadableStreamBYOBReader', 'ReadableStreamBYOBRequest',
    'ReadableStreamDefaultController', 'ReadableByteStreamController', 'WritableStream', 'WritableStreamDefaultWriter',
    'WritableStreamDefaultController', 'TransformStream', 'TransformStreamDefaultController',
    'ByteLengthQueuingStrategy', 'CountQueuingStrategy', 'Crypto', 'CryptoKey', 'SubtleCrypto',
    // storage of the guest's own opaque origin, locks, permissions, scheduling
    'IDBCursor', 'IDBCursorWithValue', 'IDBDatabase', 'IDBFactory', 'IDBIndex', 'IDBKeyRange', 'IDBObjectStore',
    'IDBOpenDBRequest', 'IDBRecord', 'IDBRequest', 'IDBTransaction', 'IDBVersionChangeEvent', 'StorageManager',
    'Lock', 'LockManager', 'Permissions', 'PermissionStatus', 'MediaCapabilities', 'Scheduler', 'TaskController',
    'TaskSignal', 'TaskPriorityChangeEvent',
    // performance
    'Performance', 'PerformanceEntry', 'PerformanceMark', 'PerformanceMeasure', 'PerformanceObserver',
    'PerformanceObserverEntryList', 'PerformanceResourceTiming', 'PerformanceServerTiming',
    // geometry, images, canvas and WebGL on an OffscreenCanvas (no URL anywhere)
    'DOMMatrix', 'DOMMatrixReadOnly', 'DOMPoint', 'DOMPointReadOnly', 'DOMQuad', 'DOMRect', 'DOMRectReadOnly',
    'ImageData', 'ImageBitmap', 'ImageBitmapRenderingContext', 'OffscreenCanvas', 'OffscreenCanvasRenderingContext2D',
    'CanvasGradient', 'CanvasPattern', 'Path2D', 'TextMetrics',
    'WebGLRenderingContext', 'WebGL2RenderingContext', 'WebGLActiveInfo', 'WebGLBuffer', 'WebGLContextEvent',
    'WebGLFramebuffer', 'WebGLObject', 'WebGLProgram', 'WebGLQuery', 'WebGLRenderbuffer', 'WebGLSampler',
    'WebGLShader', 'WebGLShaderPrecisionFormat', 'WebGLSync', 'WebGLTexture', 'WebGLTransformFeedback',
    'WebGLUniformLocation', 'WebGLVertexArrayObject',
    // WebCodecs: bytes in, frames out
    'AudioData', 'AudioDecoder', 'AudioEncoder', 'EncodedAudioChunk', 'EncodedVideoChunk', 'VideoColorSpace',
    'VideoDecoder', 'VideoEncoder', 'VideoFrame', 'ImageDecoder', 'ImageTrack', 'ImageTrackList',
];

/** What guest code may find on the worker's navigator (its prototype's members): no `serviceWorker`, no `connection`. */
export const WORKER_NAVIGATOR_MEMBERS: readonly string[] = [
    'appCodeName', 'appName', 'appVersion', 'platform', 'product', 'userAgent', 'language', 'languages',
    'onLine', 'hardwareConcurrency', 'deviceMemory', 'globalPrivacyControl', 'storage', 'locks', 'permissions',
    'mediaCapabilities', 'gpu',
];

/**
 * Deletes every global of the worker that is not in `allowed`, and every member of its navigator's prototype that is
 * not in `navigatorMembers`, before any other script of the library or the guest runs in the worker. Stringified
 * into the worker's source (host.ts); self-contained, and it reaches nothing but `g`, the object literals' own
 * Object, and the arguments. The global's names live in two places (all three engines): interfaces (and a
 * few members) are own properties of the global object, the scope's attributes and operations (`fetch`, `fonts`,
 * `caches`, `importScripts`, …) are on DedicatedWorkerGlobalScope.prototype and WorkerGlobalScope.prototype; both are
 * pruned, up to EventTarget.prototype (its methods are listeners, nothing more).
 *
 * Fails closed: a name off the list that is still there after its deletion (non-configurable), unless it is a constant
 * (a primitive value), throws, and the worker
 * script ends there, before the library's channel or any guest code exists: the worker never attaches its port
 * (worker mode) or its entry never starts (strict mode, "the guest entry failed to start").
 *
 * Returns the platform's postMessage of the worker, read before anything is deleted, or null: the one function of the
 * worker's own channel to its parent (above), for the bootstrap that has a use for it (worker mode's, once). A caller
 * that does not keep the value leaves nothing that holds it.
 */
export function keepOnlyWorkerGlobals(g: object, allowed: readonly string[], navigatorMembers: readonly string[]): ((message: unknown) => void) | null {
    const O = ({}).constructor as ObjectConstructor;
    const found = (g as { postMessage?: unknown }).postMessage; // read once, before the pruning below deletes it
    const postToParent = typeof found === 'function' ? found as (message: unknown) => void : null;
    // A WebIDL constant (Chromium's TEMPORARY and PERSISTENT on DedicatedWorkerGlobalScope.prototype) is a
    // non-configurable data property holding a number: it cannot be deleted, and a primitive makes no request.
    const isConstant = (descriptor: PropertyDescriptor) => 'value' in descriptor && (descriptor.value === null || (typeof descriptor.value !== 'object' && typeof descriptor.value !== 'function'));
    const prune =(owner: object | null, keep: readonly string[], where: string) => {
        if (!owner) return;
        const names = O.getOwnPropertyNames(owner);
        for (let i = 0; i < names.length; i++) {
            const name = names[i]!;
            if (keep.includes(name) || (name === 'constructor' && owner !== g)) continue; // a prototype keeps its constructor
            Reflect.deleteProperty(owner, name);
            const left = O.getOwnPropertyDescriptor(owner, name);
            if (!left || isConstant(left)) continue;
            throw new Error('[Sandbox] the worker could not remove ' + where + name + '; it did not start');
        }
    };
    const eventTargetPrototype = (g as { EventTarget?: { prototype: object } }).EventTarget?.prototype ?? null;
    prune(g, allowed, '');
    for (let scope = O.getPrototypeOf(g); scope && scope !== eventTargetPrototype && scope !== O.prototype; scope = O.getPrototypeOf(scope)) {
        prune(scope, allowed, '');
    }
    const navigator = (g as { navigator?: object }).navigator;
    if (navigator) prune(O.getPrototypeOf(navigator), navigatorMembers, 'navigator.');
    return postToParent;
}
