import { afterEach, describe, expect, it, vi } from 'vitest';
import { defineWebSandbox } from '@src/index';
import { inSandboxScript } from '@src/lib/in-sandbox-script';
import { SyntaxKind, tokenize } from '../../scripts/js-tokens';
import { keepOnlyWorkerGlobals, NETWORK_WORKER_GLOBALS, SEALED_WORKER_GLOBALS, STRICT_WORKER_GLOBALS, STRICT_WORKER_NAVIGATOR_MEMBERS, WORKER_GLOBALS } from '@src/lib/worker-globals';
import { startWith } from './start-app';

/**
 * Sealed mode has no network, so its worker does not have `fetch`, `XMLHttpRequest` or `WebSocket` as names (ADR-008): not
 * a function that refuses, which would be a predicate over an empty list, but nothing. This file is the default build's
 * (it imports no network module), and holds it at the three places the construction lives:
 *  - the sealed allowlist, derived from the one list of the network names (NETWORK_WORKER_GLOBALS), has none of them;
 *  - the worker removes them as it removes any name off its list: from the global object and from the scope prototypes,
 *    so no route a guest takes to a removed name finds a native;
 *  - the source of a sealed worker, and the bootstrap in it, name none of them: nothing captures them, nothing installs
 *    a gate over them, and the request gate itself is not in the source.
 * The e2e specs hold the same in the browsers (test/e2e/sealed-no-network-names.spec.ts).
 */

afterEach(() => {
    vi.restoreAllMocks();
    document.body.replaceChildren();
});

const OWN_NAMES = [...NETWORK_WORKER_GLOBALS, 'nativeFetch', 'NativeXMLHttpRequest', 'NativeWebSocket', 'replaceGlobal', 'requestGate'];

/** Every identifier and every string literal of `text` that is exactly one of the request makers' names, or a name of the gate's. */
function namedIn(text: string): string[] {
    const found: string[] = [];
    for (const token of tokenize(text)) {
        if (token.kind === SyntaxKind.Identifier && OWN_NAMES.includes(token.text)) found.push(token.text);
        if (token.kind === SyntaxKind.StringLiteral && OWN_NAMES.includes(token.text.slice(1, -1))) found.push(token.text);
    }
    return found;
}

describe("sealed mode's allowlist has none of the network names", () => {
    it('the network names are one list, strict mode keeps them and sealed mode does not', () => {
        expect([...NETWORK_WORKER_GLOBALS].sort()).toEqual(['WebSocket', 'XMLHttpRequest', 'XMLHttpRequestEventTarget', 'XMLHttpRequestUpload', 'fetch']);
        for (const name of NETWORK_WORKER_GLOBALS) {
            expect(WORKER_GLOBALS, name).toContain(name);
            expect(STRICT_WORKER_GLOBALS, `${name}: strict mode keeps it, behind its request gate`).toContain(name);
            expect(SEALED_WORKER_GLOBALS, `${name}: sealed mode has no network`).not.toContain(name);
        }
    });

    it("the sealed list is strict mode's without exactly those names, and a name of nothing else", () => {
        expect(SEALED_WORKER_GLOBALS).toEqual(STRICT_WORKER_GLOBALS.filter(name => !(NETWORK_WORKER_GLOBALS as readonly string[]).includes(name)));
        expect(STRICT_WORKER_GLOBALS.length - SEALED_WORKER_GLOBALS.length).toBe(NETWORK_WORKER_GLOBALS.length);
    });
});

/** A stand-in global shaped as a worker's: interfaces own, `fetch` on the scope prototypes (measured, all three engines). */
function worker() {
    class WorkerGlobalScope extends EventTarget {}
    Object.defineProperty(WorkerGlobalScope.prototype, 'fetch', { value: () => 'native fetch', writable: true, configurable: true });
    Object.defineProperty(WorkerGlobalScope.prototype, 'setTimeout', { value: () => 0, writable: true, configurable: true });
    class DedicatedWorkerGlobalScope extends WorkerGlobalScope {}
    // a name that is an accessor on the prototype, as an engine may spell one
    Object.defineProperty(DedicatedWorkerGlobalScope.prototype, 'WebSocket', { get: () => function WebSocket() {}, configurable: true });
    const g = new DedicatedWorkerGlobalScope() as any;
    class XMLHttpRequestEventTarget extends EventTarget {}
    class XMLHttpRequestUpload extends XMLHttpRequestEventTarget {}
    class XMLHttpRequest extends XMLHttpRequestEventTarget {
        upload = new XMLHttpRequestUpload();
    }
    for (const [name, value] of [['fetch', () => 'native fetch'], ['XMLHttpRequest', XMLHttpRequest], ['XMLHttpRequestEventTarget', XMLHttpRequestEventTarget], ['XMLHttpRequestUpload', XMLHttpRequestUpload], ['WebSocket', function WebSocket() {}], ['EventTarget', EventTarget], ['Object', Object]] as const) {
        Object.defineProperty(g, name, { value, writable: true, configurable: true });
    }
    return g;
}

describe('the sealed worker removes the names as it removes any name off its list', () => {
    const run = (g: object) => new Function(`return (${keepOnlyWorkerGlobals.toString()})`)()(g, SEALED_WORKER_GLOBALS, STRICT_WORKER_NAVIGATOR_MEMBERS);

    it('no route finds one: not the global, not its own names, not any prototype of the chain, not a reflection of it', () => {
        const g = worker();
        for (const name of NETWORK_WORKER_GLOBALS) expect(name in g, `${name} is there before`).toBe(true); // positive control
        run(g);
        const chain: object[] = [];
        for (let owner: object | null = g; owner && owner !== Object.prototype; owner = Object.getPrototypeOf(owner)) chain.push(owner);
        for (const name of NETWORK_WORKER_GLOBALS) {
            expect(name in g, name).toBe(false);
            expect(typeof (g as Record<string, unknown>)[name], name).toBe('undefined');
            expect((g as object).constructor.prototype, name).not.toHaveProperty(name);
            expect(Reflect.has(g, name), name).toBe(false);
            for (const owner of chain) {
                expect(Object.getOwnPropertyDescriptor(owner, name), `${name} on a prototype of the chain`).toBeUndefined();
                expect(Reflect.ownKeys(owner), name).not.toContain(name);
            }
        }
        expect(typeof g.setTimeout).toBe('function'); // what is listed stays
    });

    it('a name that cannot be removed ends the worker, as for every name off the list: nothing after it runs', () => {
        const g = worker();
        Object.defineProperty(g, 'fetch', { value: () => 'native fetch', configurable: false });
        expect(() => run(g)).toThrowError(/could not remove fetch/);
    });
});

describe("a sealed worker's source and its bootstrap name none of them", () => {
    it('the bootstrap, whole, has no name of the platform\'s request makers: it captures none, installs no gate over any, and is given none', () => {
        expect(namedIn(inSandboxScript.toString())).toEqual([]);
        // positive control: the scan finds a name where it is, as a property and as a string, and not in 'sandbox:fetch'
        expect(namedIn("const nativeFetch = g.fetch; list.push('WebSocket', 'sandbox:fetch');")).toEqual(['nativeFetch', 'fetch', "'WebSocket'"]);
    });

    it("the source of a sealed build's worker holds the bootstrap with `sealed`, a list without the names, and no request gate", async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        defineWebSandbox();
        const el = document.createElement('web-sandbox') as any;
        document.body.appendChild(el);
        startWith(el, { mode: 'sealed', entry: 'main.js' }, { files: { 'main.js': 'void 0' } });
        const source: string = el._strictInit.workerSource;
        expect(source).toContain('"sealed":true');
        expect(source).toContain(JSON.stringify(SEALED_WORKER_GLOBALS.filter(name => name !== 'WebAssembly')));
        expect(source).not.toContain('function requestGate(');
        expect(namedIn(source), "a request maker is named in the sealed worker's source").toEqual([]);
    });
});
