import { describe, expect, it } from 'vitest';
import { keepOnlyWorkerGlobals, WORKER_GLOBALS, WORKER_NAVIGATOR_MEMBERS } from './worker-globals';

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
});
