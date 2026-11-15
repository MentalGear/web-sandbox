import { test, expect } from './fixture';
import { NETWORK_WORKER_GLOBALS } from '@src/lib/worker-globals';

/**
 * Sealed mode has no network, so a sealed guest has no `fetch`, `XMLHttpRequest` or `WebSocket`: the names are absent, not
 * functions that refuse (ADR-008; SEALED_REACH, the `requests` surface). The default build, every engine. The guest looks
 * for each name by every route there is: `typeof`, `in`, the global object and every prototype of its chain, `Reflect.ownKeys`,
 * the constructor's prototype, a computed name, and calling it (a ReferenceError, which is what an app that does not
 * feature-detect gets). Strict mode's gate, whose names stay, is test/e2e/request-gate.spec.ts (the network build).
 */

const NAMES = [...NETWORK_WORKER_GLOBALS];

test.describe('a sealed guest has none of the platform\'s request makers as names', () => {
    test('typeof, `in`, every own key of the global and of each prototype of its chain, and a call: none is there, on any engine', async ({ sandbox }) => {
        await sandbox.open();
        const seen = await sandbox.inEntry<Record<string, any>>({ mode: 'sealed' }, `
            const names = ${JSON.stringify(NAMES)};
            const chain = [];
            for (let owner = globalThis; owner && owner !== Object.prototype; owner = Object.getPrototypeOf(owner)) chain.push(owner);
            const called = {};
            for (const name of names) {
                try { globalThis[name](); called[name] = 'returned'; } catch (e) { called[name] = e.name; }
            }
            const direct = (() => { try { return fetch('https://elsewhere.invalid/x'); } catch (e) { return e.name; } })();
            const constructed = [];
            for (const make of [() => new XMLHttpRequest(), () => new WebSocket('wss://elsewhere.invalid/x')]) {
                try { make(); constructed.push('made'); } catch (e) { constructed.push(e.name); }
            }
            return {
                typeofs: names.map((name) => name === 'fetch' ? typeof fetch : name === 'XMLHttpRequest' ? typeof XMLHttpRequest : name === 'WebSocket' ? typeof WebSocket : name === 'XMLHttpRequestUpload' ? typeof XMLHttpRequestUpload : typeof XMLHttpRequestEventTarget),
                inSelf: names.map((name) => name in self),
                inGlobal: names.map((name) => Reflect.has(globalThis, name)),
                computed: names.map((name) => typeof self[name]),
                ownKeysOfChain: chain.map((owner) => Reflect.ownKeys(owner).filter((key) => names.includes(key))),
                chainLength: chain.length,
                descriptors: chain.map((owner) => names.filter((name) => Object.getOwnPropertyDescriptor(owner, name) !== undefined)),
                viaConstructor: names.filter((name) => name in self.constructor.prototype || name in Object.getPrototypeOf(self)),
                viaScopes: [typeof WorkerGlobalScope, typeof DedicatedWorkerGlobalScope].map((kind) => kind),
                called, direct, constructed,
                // what an app is told to do: feature-detect
                detected: typeof fetch === 'undefined' && typeof XMLHttpRequest === 'undefined' && typeof WebSocket === 'undefined',
            };
        `);
        expect(seen.thrown, 'the entry ran').toBeUndefined();
        expect(seen.typeofs).toEqual(NAMES.map(() => 'undefined'));
        expect(seen.inSelf).toEqual(NAMES.map(() => false));
        expect(seen.inGlobal).toEqual(NAMES.map(() => false));
        expect(seen.computed).toEqual(NAMES.map(() => 'undefined'));
        expect(seen.chainLength, 'the chain was walked: the global, its scope prototypes').toBeGreaterThan(2);
        expect(seen.ownKeysOfChain).toEqual(seen.ownKeysOfChain.map(() => []));
        expect(seen.descriptors).toEqual(seen.descriptors.map(() => []));
        expect(seen.viaConstructor).toEqual([]);
        expect(seen.viaScopes).toEqual(['function', 'function']); // the scope interfaces are kept: the scan walked real prototypes
        expect(seen.called).toEqual(Object.fromEntries(NAMES.map((name) => [name, 'TypeError'])));
        expect(seen.direct).toBe('ReferenceError');
        expect(seen.constructed).toEqual(['ReferenceError', 'ReferenceError']);
        expect(seen.detected).toBe(true);
    });

    test('the names are gone from the bridge too: the guest\'s own API (sandboxFetch) is the one refusal it has, and no request leaves', async ({ sandbox }) => {
        await sandbox.open();
        const seen = await sandbox.inEntry<Record<string, any>>({ mode: 'sealed' }, `
            const refused = await sandboxFetch('https://elsewhere.invalid/x').then(() => 'sent', (e) => e.code);
            return { refused, hasFetchName: 'fetch' in self };
        `);
        expect(seen).toEqual({ refused: 'FETCH_NOT_ALLOWED', hasFetchName: false });
    });
});
