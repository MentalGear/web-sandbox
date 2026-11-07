import { describe, expect, it } from 'vitest';
import { keepOnlyWorkerGlobals, removeSecureContextOnly, SECURE_CONTEXT_ONLY, STRICT_WORKER_GLOBALS, STRICT_WORKER_NAVIGATOR_MEMBERS, WORKER_GLOBALS, WORKER_NAVIGATOR_MEMBERS, workerGlobalsFor } from './worker-globals';

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

    it("strict mode's list is the same without importScripts (its script-src is the view's hash, so importScripts() could load nothing) and without the secure-context-only names, and the worker then has none", () => {
        const secureOnly = (list: readonly string[], name: string) => list.includes(name);
        expect(STRICT_WORKER_GLOBALS).toEqual(WORKER_GLOBALS.filter(name => name !== 'importScripts' && !secureOnly(SECURE_CONTEXT_ONLY.globals, name)));
        expect(STRICT_WORKER_NAVIGATOR_MEMBERS).toEqual(WORKER_NAVIGATOR_MEMBERS.filter(name => !secureOnly(SECURE_CONTEXT_ONLY.navigator, name)));
        const { g, scope } = standInWorker();
        new Function(`return (${keepOnlyWorkerGlobals.toString()})`)()(g, STRICT_WORKER_GLOBALS, WORKER_NAVIGATOR_MEMBERS);
        expect(Object.getOwnPropertyNames(scope).sort()).toEqual(['constructor', 'fetch', 'navigator', 'setTimeout']);
        expect('importScripts' in g).toBe(false);
    });

    it('a build keeps WebAssembly only with scriptUnsafe (R1:R2-5): off the list it is deleted, and one that cannot be is an error', () => {
        const keep = (g: object, allowed: readonly string[]) => new Function(`return (${keepOnlyWorkerGlobals.toString()})`)()(g, allowed, WORKER_NAVIGATOR_MEMBERS);
        for (const globals of [WORKER_GLOBALS, STRICT_WORKER_GLOBALS]) {
            expect(workerGlobalsFor(globals, true)).toEqual(globals);
            expect(workerGlobalsFor(globals, false)).toEqual(globals.filter(name => name !== 'WebAssembly'));
        }
        const { g } = standInWorker();
        Object.defineProperty(g, 'WebAssembly', { value: {}, writable: true, configurable: true });
        keep(g, workerGlobalsFor(WORKER_GLOBALS, false));
        expect('WebAssembly' in g).toBe(false);
        const stuck = standInWorker();
        Object.defineProperty(stuck.g, 'WebAssembly', { value: {}, configurable: false });
        expect(() => keep(stuck.g, workerGlobalsFor(WORKER_GLOBALS, false))).toThrowError(/could not remove WebAssembly/);
    });
});

// Class A (INHERITED_CONTEXT.secureContext): on Firefox and WebKit the worker's secure context follows the host page's URL,
// so strict and sealed mode's worker has none of what only a secure context has, and reads isSecureContext as false.
describe('the strict worker is the same whatever the host page is: no secure-context-only name, and isSecureContext false', () => {
    const run = (g: object) => new Function(`return (${removeSecureContextOnly.toString()})`)()(g, SECURE_CONTEXT_ONLY.members);

    function secureStandIn() {
        class WorkerGlobalScope extends EventTarget {}
        Object.defineProperty(WorkerGlobalScope.prototype, 'isSecureContext', { get: () => true, configurable: true });
        class Crypto {}
        Object.defineProperty(Crypto.prototype, 'subtle', { get: () => ({}), configurable: true });
        Object.defineProperty(Crypto.prototype, 'randomUUID', { value: () => 'uuid', writable: true, configurable: true });
        Object.defineProperty(Crypto.prototype, 'getRandomValues', { value: (array: unknown) => array, writable: true, configurable: true });
        class PerformanceResourceTiming {}
        Object.defineProperty(PerformanceResourceTiming.prototype, 'serverTiming', { get: () => [], configurable: true });
        Object.defineProperty(PerformanceResourceTiming.prototype, 'duration', { get: () => 0, configurable: true });
        const g = new WorkerGlobalScope() as any;
        for (const [name, value] of [['Crypto', Crypto], ['PerformanceResourceTiming', PerformanceResourceTiming], ['crypto', new Crypto()]] as const) {
            Object.defineProperty(g, name, { value, writable: true, configurable: true });
        }
        return { g, scope: WorkerGlobalScope.prototype, Crypto, PerformanceResourceTiming };
    }

    it('deletes each member SECURE_CONTEXT_ONLY lists and keeps the others; isSecureContext reads false, on the global object only', () => {
        const { g, scope, Crypto, PerformanceResourceTiming } = secureStandIn();
        run(g);
        expect(Object.getOwnPropertyNames(Crypto.prototype).sort()).toEqual(['constructor', 'getRandomValues']);
        expect(Object.getOwnPropertyNames(PerformanceResourceTiming.prototype).sort()).toEqual(['constructor', 'duration']);
        expect('subtle' in g.crypto).toBe(false);
        expect(g.isSecureContext).toBe(false);
        expect(Object.getOwnPropertyNames(scope)).not.toContain('isSecureContext');
        expect(Reflect.defineProperty(g, 'isSecureContext', { value: true })).toBe(false); // guest code cannot set it back
    });

    it('an interface the engine does not have is skipped; a member that cannot be deleted throws, so nothing after it in the worker runs', () => {
        const absent = secureStandIn();
        delete absent.g.PerformanceResourceTiming;
        run(absent.g);
        expect(absent.g.isSecureContext).toBe(false);
        const stuck = secureStandIn();
        Object.defineProperty(stuck.Crypto.prototype, 'subtle', { get: () => ({}), configurable: false });
        expect(() => run(stuck.g)).toThrowError(/could not remove Crypto\.prototype\.subtle/);
    });

    it('the lists are disjoint from what the strict worker keeps, and each name is one the allowlists list', () => {
        for (const name of SECURE_CONTEXT_ONLY.globals) {
            expect(WORKER_GLOBALS, name).toContain(name);
            expect(STRICT_WORKER_GLOBALS, name).not.toContain(name);
        }
        for (const name of SECURE_CONTEXT_ONLY.navigator) {
            expect(WORKER_NAVIGATOR_MEMBERS, name).toContain(name);
            expect(STRICT_WORKER_NAVIGATOR_MEMBERS, name).not.toContain(name);
        }
        for (const [owner] of SECURE_CONTEXT_ONLY.members) expect(STRICT_WORKER_GLOBALS, owner).toContain(owner);
    });
});
