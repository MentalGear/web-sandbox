import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootstrapListeners, EGRESS, UNCAUGHT_CHARACTERS_PER_SECOND, UNCAUGHT_PER_SECOND, type EgressMode } from '@src/lib/egress';
import { inSandboxScript } from '@src/lib/in-sandbox-script';
import { workerBootstrap } from '@src/lib/worker-bootstrap';
import { createBroker } from '@src/lib/rpc';
import { createSizeOf } from '@src/lib/structured-size';
import { defineWebSandbox } from '@src/host';
import { SyntaxKind, tokenize } from '../../scripts/js-tokens';

/**
 * The egress table (class E-cpu, R5:N-1): every row has its bound and its test, and the bootstrap installs
 * exactly the listeners of its rows, doing what each row says. The per-engine enumeration of the surfaces themselves is
 * test/e2e/egress.spec.ts.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (file: string) => readFileSync(path.join(ROOT, file), 'utf8');

defineWebSandbox();

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    delete (globalThis as any).bridge;
    delete (globalThis as any).sandboxFetch;
    document.body.replaceChildren();
});

// Event classes as the platform makes them: the fields on the prototype, as getters, and isTrusted an own property.
class TrustedEvent {
    readonly isTrusted = true;
    defaultPrevented = false;
    preventDefault() { this.defaultPrevented = true; }
    stopImmediatePropagation() {}
}
class ErrorEventLike extends TrustedEvent {
    constructor(private readonly init: { message?: string; error?: unknown }) { super(); }
    get message() { return this.init.message ?? ''; }
    get error() { return this.init.error; }
}
class RejectionEventLike extends TrustedEvent {
    constructor(private readonly init: { reason?: unknown; promise?: unknown }) { super(); }
    get reason() { return this.init.reason; }
    get promise() { return this.init.promise; }
}

// The bootstrap of `mode`, as the host builds it (its listeners from the table), on a stand-in global: what it registers
// on it, and what it posts on its port.
function bootstrap(mode: EgressMode) {
    const registered: { type: string; listener: (event: unknown) => void; capture: unknown }[] = [];
    vi.stubGlobal('addEventListener', (type: string, listener: (event: unknown) => void, capture: unknown) => { registered.push({ type, listener, capture }); });
    vi.stubGlobal('Event', TrustedEvent);
    vi.stubGlobal('ErrorEvent', ErrorEventLike);
    vi.stubGlobal('PromiseRejectionEvent', RejectionEventLike);
    const closed: number[] = [];
    vi.stubGlobal('close', () => closed.push(sent.length)); // the worker's own close(): how many frames had left by then
    // A port whose postMessage keeps what it is given (the bootstrap posts through MessagePort.prototype's, captured).
    class KeptPort {
        frames: any[] = [];
        postMessage(frame: unknown) { (this.frames ??= []).push(structuredClone(frame)); }
        set onmessage(_handler: unknown) {}
    }
    vi.stubGlobal('MessagePort', KeptPort);
    const port = new KeptPort();
    const sent = port.frames;
    const features = { externalPort: mode === 'strict', callBudget: { calls: 1000, bytes: 67108864 }, listeners: bootstrapListeners(mode), uncaught: { count: UNCAUGHT_PER_SECOND, characters: UNCAUGHT_CHARACTERS_PER_SECOND } };
    const comms = inSandboxScript(false, mode, new Proxy({}, { get: () => () => {} }) as Console, createBroker, features as any, createSizeOf);
    if (mode !== 'cooperative') comms.attach(port as unknown as MessagePort);
    const on = (type: string) => registered.filter(entry => entry.type === type).map(entry => entry.listener);
    return { registered, sent, on, closed };
}

describe('the table', () => {
    it('every row has a bound and a test, and its handling says what is done', () => {
        for (const row of EGRESS) {
            const where = `${row.realm} ${row.surface} (${row.owner})`;
            expect(row.bound.trim().length, where).toBeGreaterThan(10);
            expect(row.test.trim().length, where).toBeGreaterThan(5);
            expect(row.handling.length, where).toBeGreaterThan(0);
            expect(row.modes.length, where).toBeGreaterThan(0);
        }
    });

    it('a surface of a realm and mode is decided once per owner: no two rows of one owner say different things about it', () => {
        const seen = new Map<string, string>();
        for (const row of EGRESS) {
            for (const mode of row.modes) {
                const key = `${row.realm}|${row.surface}|${mode}|${row.owner}`;
                expect(seen.has(key), key).toBe(false);
                seen.set(key, row.handling.join(','));
            }
        }
    });

    it('rejections are cancelled after relaying, and counted, in worker and strict mode; errors in worker mode; rejectionhandled counted', () => {
        expect(bootstrapListeners('worker')).toEqual(expect.arrayContaining([
            { type: 'error', target: 'global', relay: true, cancel: true, budget: true },
            { type: 'unhandledrejection', target: 'global', relay: true, cancel: true, budget: true },
            { type: 'rejectionhandled', target: 'global', relay: false, cancel: false, budget: true },
        ]));
        expect(bootstrapListeners('strict')).toEqual(expect.arrayContaining([
            { type: 'error', target: 'global', relay: false, cancel: false, budget: true },
            { type: 'unhandledrejection', target: 'global', relay: true, cancel: true, budget: true },
            { type: 'rejectionhandled', target: 'global', relay: false, cancel: false, budget: true },
        ]));
        expect(bootstrapListeners('cooperative')).toEqual(expect.arrayContaining([
            { type: 'error', target: 'global', relay: true, cancel: false, budget: false },
            { type: 'unhandledrejection', target: 'global', relay: true, cancel: false, budget: false },
        ]));
    });
});

describe('the bootstrap installs the listeners of its rows, and no other', () => {
    for (const mode of ['worker', 'strict', 'cooperative'] as const) {
        it(`${mode} mode: one capture listener per row, plus its own channel (worker mode's INIT_PORT)`, () => {
            if (mode === 'cooperative') vi.spyOn(window.parent, 'postMessage').mockImplementation(() => {});
            const { registered } = bootstrap(mode);
            const expected = bootstrapListeners(mode).map(listener => listener.type);
            if (mode === 'worker') expected.push('message');
            expect(registered.map(entry => entry.type).sort()).toEqual(expected.sort());
            for (const entry of registered) expect(entry.capture, entry.type).toBe(true);
        });
    }

    it('the source: the bootstrap adds a listener to the global only from the table, and to anything else only its own channel and gate', () => {
        const tokens = tokenize(inSandboxScript.toString());
        const calls: string[] = [];
        for (let i = 0; i + 4 < tokens.length; i++) {
            if (tokens[i]!.kind !== SyntaxKind.Identifier || tokens[i]!.text !== 'apply' || tokens[i + 1]!.kind !== SyntaxKind.OpenParenToken) continue;
            const callee = tokens[i + 2]!.text;
            if (callee !== 'addGlobalListener' && callee !== 'listen') continue;
            // the event type: the first element of the argument list after the target
            const type = tokens.slice(i + 3, i + 12).map(token => token.text).join(' ');
            calls.push(`${callee} ${type}`);
        }
        // the table's loop (a listener's type is the row's), worker mode's INIT_PORT (the worker's message row), and
        // cooperative mode's DOMContentLoaded row: the startup gate (registered again by each frame it holds) and
        // auto-sizing's look at the body
        expect(calls.sort()).toEqual([
            'addGlobalListener , g , [ "message" , onInit , true',
            'addGlobalListener , g , [ listener . type , handler',
            'listen , doc , [ "DOMContentLoaded" , ( ) =>',
            'listen , doc , [ "DOMContentLoaded" , onParsed , true',
            'listen , doc , [ "DOMContentLoaded" , onParsed , true',
        ].sort());
        const rows = EGRESS.filter(row => row.owner === 'guest-script');
        expect(rows.some(row => row.realm === 'worker' && row.surface === 'message')).toBe(true);
        expect(rows.some(row => row.realm === 'cooperative' && row.surface === 'DOMContentLoaded')).toBe(true);
    });

    it("worker mode's frame listens to its Worker object only as its rows say: one WORKER_STARTED, then errors before the start", () => {
        const source = workerBootstrap.toString();
        const handlers = [...source.matchAll(/worker\.(on\w+) =/g)].map(match => match[1]!);
        expect([...new Set(handlers)].sort()).toEqual(['onerror', 'onmessage']);
        const rows = EGRESS.filter(row => row.owner === 'worker-bootstrap' && row.realm === 'worker-object').map(row => row.surface);
        for (const handler of handlers) expect(rows).toContain(handler.slice(2));
    });
});

describe('what each listener does (5:N-1)', () => {
    for (const mode of ['worker', 'strict'] as const) {
        it(`${mode} mode: an unhandled rejection is relayed, then cancelled, so the browser does not report it as well`, () => {
            const { on, sent } = bootstrap(mode);
            const event = new RejectionEventLike({ reason: new RangeError('no') });
            for (const listener of on('unhandledrejection')) listener(event);
            expect(sent.filter(frame => frame.type === 'LOG').map(frame => frame.args[0])).toContain('Uncaught (in promise) RangeError: no');
            expect(event.defaultPrevented).toBe(true);
        });

        it(`${mode} mode: past ${UNCAUGHT_PER_SECOND} uncaught errors and rejections in one second, one frame tells the element, once, and then the worker stops itself`, async () => {
            const { on, sent, closed } = bootstrap(mode);
            for (let i = 0; i <= UNCAUGHT_PER_SECOND + 10; i++) {
                const type = i % 3 === 0 ? 'error' : i % 3 === 1 ? 'unhandledrejection' : 'rejectionhandled';
                const event = type === 'error' ? new ErrorEventLike({ message: 'Uncaught Error: e', error: new Error('e') }) : new RejectionEventLike({ reason: new Error('r') });
                for (const listener of on(type)) listener(event);
            }
            await new Promise(resolve => setTimeout(resolve, 5)); // the frame leaves in a task of its own
            expect(sent.filter(frame => frame.type === 'UNCAUGHT_PAST_BUDGET')).toEqual([{ type: 'UNCAUGHT_PAST_BUDGET' }]);
            // close() came once, after the frame had left
            expect(closed).toEqual([sent.findIndex(frame => frame.type === 'UNCAUGHT_PAST_BUDGET') + 1]);
        });

        it(`${mode} mode: past ${UNCAUGHT_CHARACTERS_PER_SECOND} characters of them, as the browser reads them (name and message, data properties; a string), at once`, async () => {
            const { on, sent } = bootstrap(mode);
            const big = new Error('x'.repeat(UNCAUGHT_CHARACTERS_PER_SECOND));
            for (const listener of on('unhandledrejection')) listener(new RejectionEventLike({ reason: big }));
            await new Promise(resolve => setTimeout(resolve, 5));
            expect(sent.filter(frame => frame.type === 'UNCAUGHT_PAST_BUDGET')).toHaveLength(1);
        });

        // S78: what the browser makes a costly report of is its own class of the object, never what the object says of itself
        const identities: [string, () => unknown][] = [
            ['an Error with its own Symbol.toStringTag', () => Object.defineProperty(new Error('x'.repeat(UNCAUGHT_CHARACTERS_PER_SECOND + 1)), Symbol.toStringTag, { value: 'X' })],
            ['an Error whose DOMException-like tag is a getter that throws', () => Object.defineProperty(new Error('x'.repeat(UNCAUGHT_CHARACTERS_PER_SECOND + 1)), Symbol.toStringTag, { get() { throw new Error('no'); } })],
            ['a plain object with a name and a message', () => ({ name: 'N', message: 'x'.repeat(UNCAUGHT_CHARACTERS_PER_SECOND + 1) })],
            ['an object tagged as an Error that is not one', () => ({ [Symbol.toStringTag]: 'Error', message: 'x'.repeat(UNCAUGHT_CHARACTERS_PER_SECOND + 1) })],
            ['a function with a long name', () => Object.defineProperty(() => 1, 'name', { value: 'n'.repeat(UNCAUGHT_CHARACTERS_PER_SECOND + 1) })],
            ['an Error whose message is a String object', () => Object.defineProperty(new Error('s'), 'message', { value: new String('x'.repeat(UNCAUGHT_CHARACTERS_PER_SECOND + 1)) })],
            ['a DOMException', () => new DOMException('x'.repeat(UNCAUGHT_CHARACTERS_PER_SECOND + 1), 'AbortError')],
            ['a DOMException tagged by defineProperty', () => Object.defineProperty(new DOMException('x'.repeat(UNCAUGHT_CHARACTERS_PER_SECOND + 1), 'AbortError'), Symbol.toStringTag, { value: 'X' })],
            ['a subclass of Error', () => new (class Failure extends Error {})('x'.repeat(UNCAUGHT_CHARACTERS_PER_SECOND + 1))],
            ['a Proxy of an Error', () => new Proxy(new Error('x'.repeat(UNCAUGHT_CHARACTERS_PER_SECOND + 1)), {})],
            ['an array that carries a message', () => Object.assign([1], { message: 'x'.repeat(UNCAUGHT_CHARACTERS_PER_SECOND + 1) })],
            ['an Error whose name and message share the characters', () => Object.assign(new Error('m'), { name: 'n'.repeat(UNCAUGHT_CHARACTERS_PER_SECOND / 2), message: 'm'.repeat(UNCAUGHT_CHARACTERS_PER_SECOND / 2 + 1) })],
        ];
        for (const [label, make] of identities) {
            it(`${mode} mode: ${label} is counted by its name and message, and ends the sandbox past the characters budget`, async () => {
                const { on, sent } = bootstrap(mode);
                for (const listener of on('unhandledrejection')) listener(new RejectionEventLike({ reason: make() }));
                await new Promise(resolve => setTimeout(resolve, 5));
                expect(sent.filter(frame => frame.type === 'UNCAUGHT_PAST_BUDGET')).toHaveLength(1);
            });
        }

        it(`${mode} mode: Error.prototype tagged by the guest changes nothing: every error is still counted by its characters`, async () => {
            const tag = Object.getOwnPropertyDescriptor(Error.prototype, Symbol.toStringTag);
            Object.defineProperty(Error.prototype, Symbol.toStringTag, { configurable: true, value: 'X' });
            try {
                const { on, sent } = bootstrap(mode);
                for (const listener of on('unhandledrejection')) listener(new RejectionEventLike({ reason: new Error('x'.repeat(UNCAUGHT_CHARACTERS_PER_SECOND + 1)) }));
                await new Promise(resolve => setTimeout(resolve, 5));
                expect(sent.filter(frame => frame.type === 'UNCAUGHT_PAST_BUDGET')).toHaveLength(1);
            } finally {
                if (tag) Object.defineProperty(Error.prototype, Symbol.toStringTag, tag);
                else delete (Error.prototype as any)[Symbol.toStringTag];
            }
        });

        it(`${mode} mode: the characters of a report are decided before, and apart from, how the object identifies itself`, () => {
            const source = read('src/lib/in-sandbox-script.ts');
            const report = source.slice(source.indexOf('const reportOf = '), source.indexOf('const errorText = '));
            expect(report).toContain('const characters = ');
            expect(report.indexOf('const characters = ')).toBeLessThan(report.indexOf('isErrorLike('));
        });

        it(`${mode} mode: a rejection with neither name nor message, a number or null costs nothing, and its line is as before`, async () => {
            const { on, sent } = bootstrap(mode);
            for (const reason of [{}, 42, null, undefined, Symbol('s'), [1, 2], new Map()]) {
                for (const listener of on('unhandledrejection')) listener(new RejectionEventLike({ reason }));
            }
            await new Promise(resolve => setTimeout(resolve, 5));
            expect(sent.filter(frame => frame.type === 'UNCAUGHT_PAST_BUDGET')).toEqual([]);
            expect(sent.filter(frame => frame.type === 'LOG').map(frame => frame.args[0]).filter(line => line.startsWith('Uncaught'))).toEqual([
                'Uncaught (in promise) [object Object]', 'Uncaught (in promise) 42', 'Uncaught (in promise) null', 'Uncaught (in promise) undefined',
                'Uncaught (in promise) Symbol(s)', 'Uncaught (in promise) [object Array]', 'Uncaught (in promise) [object Map]',
            ]);
        });

        it(`${mode} mode: within the budget, nothing is said, and a getter's answer is what is counted (the browser does not call it: counted all the same, the safe side)`, async () => {
            const { on, sent } = bootstrap(mode);
            let reads = 0;
            const sneaky = new Error('small');
            Object.defineProperty(sneaky, 'message', { get() { reads++; return 'small'; } });
            for (let i = 0; i < 100; i++) for (const listener of on('unhandledrejection')) listener(new RejectionEventLike({ reason: sneaky }));
            await new Promise(resolve => setTimeout(resolve, 5));
            expect(sent.filter(frame => frame.type === 'UNCAUGHT_PAST_BUDGET')).toEqual([]);
            expect(reads).toBe(100); // once per rejection
        });
    }

    it('cooperative mode: relayed, not cancelled (the guest document\'s console is its own), and not counted', () => {
        vi.spyOn(window.parent, 'postMessage').mockImplementation(() => {});
        const { on } = bootstrap('cooperative');
        const event = new RejectionEventLike({ reason: new Error('r') });
        for (const listener of on('unhandledrejection')) listener(event);
        expect(event.defaultPrevented).toBe(false);
        expect(on('rejectionhandled')).toEqual([]);
    });

    it('the element ends the sandbox on the frame, with the documented reason', () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const el = document.createElement('web-sandbox') as any;
        document.body.appendChild(el);
        el.setConfig({ mode: 'worker' });
        const { port1 } = new MessageChannel();
        el._port = port1;
        const reasons: string[] = [];
        el.addEventListener('terminated', (e: CustomEvent) => reasons.push(e.detail.reason));
        el._onGuestMessage(port1, () => {}, { type: 'UNCAUGHT_PAST_BUDGET' }, null);
        expect(reasons).toEqual(['the guest raised more uncaught errors or unhandled rejections in one second than their budget allows']);
        expect(read('docs/API.md')).toContain('the guest raised more uncaught errors or unhandled rejections in one second than their budget allows');
        port1.close();
    });
});
