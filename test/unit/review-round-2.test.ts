import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { inSandboxScript } from '@src/lib/in-sandbox-script';
import { inSandboxFiles } from '@src/lib/in-sandbox-files';
import { inSandboxView, inStrictWorker, sanitizeRender, VIEW_OPTIONS, viewBootstrapSource } from '@src/lib/in-sandbox-view';
import { defineWebSandbox, SAME_DATA_MAX_PAIRS } from '@src/host';
import { createBroker, RPC_MAX_BYTES } from '@src/lib/rpc';
import { createSizeOf } from '@src/lib/structured-size';
import { LOG_EVENTS_PER_SECOND, LOG_MAX_BYTES, LOG_MAX_STRING } from '@src/lib/sandbox-log';
import { SyntaxKind, tokenize, type Token } from '../../scripts/js-tokens';

/**
 * Review round 2 (reviewer C): each finding reproduced here first, against the code it names. The bootstrap runs against
 * stand-in ports whose postMessage structured-clones the frame, as a browser's does (as in review-round-1.test.ts).
 */

class FakeEvent {
    stopImmediatePropagation() {}
}
class FakeMessageEvent extends FakeEvent {
    readonly isTrusted = true;
    constructor(private readonly init: { data?: unknown; ports?: unknown[] }) { super(); }
    get data() { return this.init.data; }
    get ports() { return this.init.ports ?? []; }
}
class ClonePort {
    frames: any[] = [];
    private handler: ((event: unknown) => void) | null = null;
    postMessage(frame: unknown) { this.frames.push(structuredClone(frame)); }
    get onmessage() { return this.handler; }
    set onmessage(handler) { this.handler = handler; }
    deliver(data: unknown) { this.handler!(new FakeMessageEvent({ data })); }
}
class FakeMessageChannel {
    static last: FakeMessageChannel | null = null;
    readonly port1 = new ClonePort();
    readonly port2 = new ClonePort();
    constructor() { FakeMessageChannel.last = this; }
}
const PLATFORM = { MessagePort: ClonePort, MessageEvent: FakeMessageEvent, Event: FakeEvent, MessageChannel: FakeMessageChannel };
const originals: Record<string, unknown> = {};
const originalAddEventListener = globalThis.addEventListener;

beforeEach(() => {
    for (const [name, value] of Object.entries(PLATFORM)) {
        originals[name] = (globalThis as any)[name];
        (globalThis as any)[name] = value;
    }
    (globalThis as any).addEventListener = () => {};
    vi.spyOn(window, 'postMessage').mockImplementation(() => {});
});

afterEach(() => {
    globalThis.addEventListener = originalAddEventListener;
    for (const name of Object.keys(PLATFORM)) (globalThis as any)[name] = originals[name];
    delete (globalThis as any).bridge;
    delete (globalThis as any).sandboxFiles;
    delete (globalThis as any).sandboxFetch;
    vi.restoreAllMocks();
});

/** A stand-in for the browser's console: every method records what it was given. */
function recordingConsole() {
    const calls: [string, unknown[]][] = [];
    const names = ['log', 'info', 'warn', 'error', 'debug', 'trace', 'dir', 'dirxml', 'table', 'group', 'groupCollapsed', 'groupEnd', 'assert',
        'count', 'countReset', 'time', 'timeLog', 'timeEnd', 'timeStamp', 'profile', 'profileEnd', 'clear'];
    const console: Record<string, (...args: unknown[]) => void> = {};
    for (const name of names) console[name] = (...args: unknown[]) => { calls.push([name, args]); };
    return { console: console as unknown as Console, calls };
}

/** The bootstrap in cooperative mode: its own channel's port1, attached at once; the browser's console is still given lines (M-5). */
function cooperativeComms(console: Console) {
    inSandboxScript(false, 'cooperative', console, createBroker, undefined, createSizeOf);
    const port = FakeMessageChannel.last!.port1;
    port.frames.length = 0;
    return { port, lines: () => port.frames.filter(frame => frame.type === 'LOG') };
}

/** The bootstrap as the host builds it in strict mode (externalPort), attached to a cloning port. */
function strictComms(console: Console) {
    const comms = inSandboxScript(false, 'strict', console, createBroker, { externalPort: true }, createSizeOf);
    const port = new ClonePort();
    comms.attach(port as any);
    port.frames.length = 0;
    return { comms, port, lines: () => port.frames.filter(frame => frame.type === 'LOG') };
}

describe('C-1: code that runs after guest code started reads nothing the guest can replace', () => {
    it("a guest that replaces Math.min does not lift the relay's per-second line cap", () => {
        let now = 1000;
        vi.spyOn(performance, 'now').mockImplementation(() => now);
        const { console } = recordingConsole();
        const { lines } = strictComms(console);
        const min = Math.min;
        try {
            Math.min = () => Infinity; // the guest's
            for (let i = 0; i < 3 * LOG_EVENTS_PER_SECOND; i++) console.log(i);
        } finally {
            Math.min = min;
        }
        const sent = lines();
        expect(sent.filter(line => /lines past that are dropped/.test(String(line.args[0])))).toHaveLength(1);
        expect(sent.length).toBeLessThanOrEqual(LOG_EVENTS_PER_SECOND + 1);
        now += 1000; // positive control: the budget refills
        console.log('later');
        expect(lines().at(-1)!.args).toEqual(['later']);
    });

    // The scan. Every function stringified into a realm where guest code runs, and whose closures outlive the start of
    // guest code, captures what it uses in one list at its top, ended by `const CAPTURE_POINT = …`; the list holds no
    // closure (one would run later, unscanned), and after that point the text names no global, reads no property of the global object (`g`), and uses no syntax that consults a prototype
    // the guest can patch (spread and iteration go through Array.prototype[Symbol.iterator], instanceof through
    // Symbol.hasInstance, a method call through the receiver's prototype). Not scanned, each for its reason:
    //   inSandboxImportMap, inSandboxMarkup, keepOnlyWorkerGlobals, assertEntryScoped, removeWebAssembly: they run to
    //     their end before any guest code and leave no closure behind;
    //   workerBootstrap: the worker-mode frame runs no guest code at all;
    //   inSandboxView, sanitizeRender: the view runs no guest code at all.
    const GUEST_REALM_FUNCTIONS: [string, (...args: any[]) => unknown][] = [
        ['inSandboxScript', inSandboxScript],
        ['createBroker', createBroker],
        ['createSizeOf', createSizeOf],
        ['inSandboxFiles', inSandboxFiles],
        ['inStrictWorker', inStrictWorker],
    ];
    // Globals of every realm the bootstrap runs in (window or worker): the intrinsics, and the platform's functions and
    // objects. `undefined`, `NaN` and `Infinity` are not here: they are non-writable and non-configurable.
    const GLOBALS = new Set([
        'Object', 'Function', 'Array', 'Number', 'Boolean', 'String', 'Symbol', 'BigInt', 'Date', 'RegExp', 'Promise', 'Proxy',
        'Reflect', 'JSON', 'Math', 'Intl', 'Atomics', 'Iterator', 'Error', 'AggregateError', 'EvalError', 'RangeError',
        'ReferenceError', 'SyntaxError', 'TypeError', 'URIError', 'ArrayBuffer', 'SharedArrayBuffer', 'DataView', 'Int8Array',
        'Uint8Array', 'Uint8ClampedArray', 'Int16Array', 'Uint16Array', 'Int32Array', 'Uint32Array', 'Float32Array',
        'Float64Array', 'BigInt64Array', 'BigUint64Array', 'Map', 'Set', 'WeakMap', 'WeakSet', 'WeakRef', 'eval', 'isNaN',
        'isFinite', 'parseInt', 'parseFloat', 'encodeURIComponent', 'decodeURIComponent', 'escape', 'unescape',
        'globalThis', 'self', 'window', 'document', 'parent', 'top', 'frames', 'navigator', 'location', 'console',
        'performance', 'structuredClone', 'queueMicrotask', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
        'requestAnimationFrame', 'postMessage', 'addEventListener', 'removeEventListener', 'dispatchEvent', 'reportError',
        'fetch', 'Request', 'Response', 'Headers', 'Blob', 'File', 'URL', 'TextEncoder', 'TextDecoder', 'atob', 'btoa',
        'MessageChannel', 'MessagePort', 'MessageEvent', 'Event', 'EventTarget', 'ErrorEvent', 'DOMException',
        'ResizeObserver', 'MutationObserver', 'History', 'Navigation', 'trustedTypes', 'crypto', 'Worker',
    ]);
    // Methods called on objects these functions make themselves, as own data properties: a pending call's resolve and
    // reject and its timeout's disarm (rpc.ts), the strict prelude's handler entries and the comms object it is given.
    const OWN_METHODS = new Set(['resolve', 'reject', 'disarm', 'handler', 'attach']);
    // Accessors of the platform's prototypes (a Map's size, a buffer's length, an event's data): read through a getter
    // captured in the list, never through the object.
    const ACCESSORS = new Set(['size', 'byteLength', 'byteOffset', 'buffer', 'data', 'ports', 'source']);

    // The innermost bracket open at `index`: its index, or -1.
    const openerOf = (tokens: Token[], index: number) => {
        let depth = 0;
        for (let i = index - 1; i >= 0; i--) {
            const kind = tokens[i]!.kind;
            if (kind === SyntaxKind.CloseParenToken || kind === SyntaxKind.CloseBracketToken || kind === SyntaxKind.CloseBraceToken) depth++;
            else if (kind === SyntaxKind.OpenParenToken || kind === SyntaxKind.OpenBracketToken || kind === SyntaxKind.OpenBraceToken || kind === SyntaxKind.TemplateHead || kind === SyntaxKind.TemplateMiddle) {
                if (depth === 0) return i;
                depth--;
            }
        }
        return -1;
    };
    const closerOf = (tokens: Token[], open: number) => {
        let depth = 0;
        for (let i = open; i < tokens.length; i++) {
            const kind = tokens[i]!.kind;
            if (kind === SyntaxKind.OpenParenToken) depth++;
            else if (kind === SyntaxKind.CloseParenToken && --depth === 0) return i;
        }
        return -1;
    };

    /** What the text uses after its capture point that guest code could have replaced, as "line: snippet" strings. */
    function usesAfterCapture(text: string): string[] {
        const tokens = tokenize(text);
        const marks = tokens.flatMap((token, i) => (token.kind === SyntaxKind.Identifier && token.text === 'CAPTURE_POINT' && tokens[i - 1]?.kind === SyntaxKind.ConstKeyword ? [i] : []));
        if (marks.length !== 1) return [`expected one "const CAPTURE_POINT", found ${marks.length}`];
        let start = marks[0]!;
        while (tokens[start]!.kind !== SyntaxKind.SemicolonToken) start++;
        const found: string[] = [];
        const at = (i: number, what: string) => {
            const line = text.slice(0, tokens[i]!.start).split('\n').length;
            found.push(`${line}: ${what}: ${text.slice(tokens[Math.max(0, i - 3)]!.start, tokens[Math.min(tokens.length - 1, i + 3)]!.end).replace(/\s+/g, ' ')}`);
        };
        // The captured list itself only captures: a closure written there would run later, unscanned.
        for (let i = 1; i < start; i++) {
            const kind = tokens[i]!.kind;
            if (kind === SyntaxKind.EqualsGreaterThanToken || kind === SyntaxKind.FunctionKeyword) at(i, 'a closure in the captured list');
        }
        for (let i = start + 1; i < tokens.length; i++) {
            const token = tokens[i]!;
            const before = tokens[i - 1]?.kind;
            const member = before === SyntaxKind.DotToken || before === SyntaxKind.QuestionDotToken;
            const next = tokens[i + 1]?.kind;
            const named = before === SyntaxKind.FunctionKeyword; // a function expression's own name, not a reference
            if (token.kind === SyntaxKind.Identifier && !member && !named && GLOBALS.has(token.text) && next !== SyntaxKind.ColonToken) at(i, `the global ${token.text}`);
            if (token.kind === SyntaxKind.Identifier && !member && token.text === 'g' && (next === SyntaxKind.DotToken || next === SyntaxKind.OpenBracketToken || next === SyntaxKind.QuestionDotToken)) at(i, 'a property of the global object');
            if (token.kind === SyntaxKind.Identifier && member && next === SyntaxKind.OpenParenToken && !OWN_METHODS.has(token.text)) at(i, `a method call .${token.text}()`);
            if (token.kind === SyntaxKind.Identifier && member && ACCESSORS.has(token.text)) at(i, `a prototype accessor .${token.text}`);
            if (token.kind === SyntaxKind.CloseBracketToken && next === SyntaxKind.OpenParenToken) at(i, 'a computed method call');
            if (token.kind === SyntaxKind.InstanceOfKeyword) at(i, 'instanceof');
            if (token.kind === SyntaxKind.OfKeyword && !member) at(i, 'for…of');
            if (token.kind === SyntaxKind.InKeyword && tokens[i - 3]?.kind === SyntaxKind.OpenParenToken && tokens[i - 4]?.kind === SyntaxKind.ForKeyword) at(i, 'for…in');
            if ((token.kind === SyntaxKind.ConstKeyword || token.kind === SyntaxKind.LetKeyword || token.kind === SyntaxKind.VarKeyword) && next === SyntaxKind.OpenBracketToken) at(i, 'array destructuring');
            if (token.kind === SyntaxKind.DotDotDotToken) {
                const open = openerOf(tokens, i);
                const after = open >= 0 && tokens[open]!.kind === SyntaxKind.OpenParenToken ? tokens[closerOf(tokens, open) + 1]?.kind : undefined;
                if (after !== SyntaxKind.EqualsGreaterThanToken && after !== SyntaxKind.OpenBraceToken) at(i, 'spread');
            }
        }
        return found;
    }

    it.each(GUEST_REALM_FUNCTIONS)('%s: after its captured list, no global, no property of the global object, no method call through a prototype, no spread or iteration', (_name, fn) => {
        expect(usesAfterCapture(fn.toString())).toEqual([]);
    });

    it('the scan finds what it looks for (positive control)', () => {
        const sample = `function f(a, ...rest) {
            const min = Math.min;
            const later = () => Math.max(1, 2);
            const CAPTURE_POINT = 'x';
            const t = Math.min(1, 2);
            const s = [...rest];
            for (const x of rest) {}
            for (const k in a) {}
            const [p, q] = rest;
            a.slice(0);
            a[0]();
            g.x;
            a.size;
            const ok = (...args) => min(args.length, 2);
            return a instanceof Object || \`\${JSON}\`;
        }`;
        expect(usesAfterCapture(sample).map(line => line.split(': ')[1])).toEqual([
            'a closure in the captured list', 'the global Math', 'a method call .min()', 'spread', 'for…of', 'for…in', 'array destructuring', 'a method call .slice()', 'a computed method call',
            'a property of the global object', 'a prototype accessor .size', 'instanceof', 'the global Object', 'the global JSON',
        ]);
    });
});

describe('C-2: the console wrappers never hand the browser console what the relay did not bound', () => {
    it('with Array.prototype[Symbol.iterator] patched, trace and assert still relay, and the browser console gets the bounded line', () => {
        const { console, calls } = recordingConsole();
        const { lines } = cooperativeComms(console);
        const long = 'x'.repeat(LOG_MAX_STRING + 10);
        const iterator = Array.prototype[Symbol.iterator];
        try {
            Array.prototype[Symbol.iterator] = function () { throw new Error('patched'); };
            (console as any).trace(long);
            (console as any).assert(false, long);
        } finally {
            Array.prototype[Symbol.iterator] = iterator;
        }
        expect(lines().map(line => [line.args[0], (line.args[1] as string).length])).toEqual([['console.trace()', LOG_MAX_STRING], ['Assertion failed:', LOG_MAX_STRING]]);
        const forwarded = calls.filter(([name]) => name === 'trace' || name === 'assert');
        expect(forwarded.map(([name, args]) => [name, args.length])).toEqual([['trace', 1], ['assert', 2]]);
        expect(forwarded.flatMap(([, args]) => args.filter(arg => typeof arg === 'string' && arg.length > LOG_MAX_STRING))).toEqual([]);
    });

    it('count, time, timeLog and the other methods that relay nothing are bounded too: cut, and within the per-second budget', () => {
        let now = 1000;
        vi.spyOn(performance, 'now').mockImplementation(() => now);
        const { console, calls } = recordingConsole();
        cooperativeComms(console);
        const long = 'x'.repeat(LOG_MAX_STRING + 10);
        const c = console as any;
        c.count(long);
        c.time(long);
        c.timeLog(long, { a: 'x'.repeat(LOG_MAX_BYTES) });
        c.timeEnd(long);
        const given = calls.flatMap(([, args]) => args);
        expect(given.filter(arg => typeof arg === 'string' && arg.length > LOG_MAX_STRING)).toEqual([]);
        expect(given.filter(arg => typeof arg === 'object' && arg !== null)).toEqual([]); // past the line's byte budget: a string saying so
        calls.length = 0;
        for (let i = 0; i < 3 * LOG_EVENTS_PER_SECOND; i++) c.count('n');
        expect(calls.length).toBeLessThanOrEqual(LOG_EVENTS_PER_SECOND);
    });
});

describe('C-3: the byte measure is an allow-list over what is actually posted', () => {
    const LIMIT = 1024 * 1024;

    it('an Error, a RegExp and a BigInt measure what clone copies: a large one is past the budget (each measured ~16 bytes)', () => {
        const sizeOf = createSizeOf();
        expect(sizeOf(new Error('x'.repeat(LIMIT)), LIMIT)).toBeGreaterThan(LIMIT);
        expect(sizeOf(new RegExp('a'.repeat(LIMIT)), LIMIT)).toBeGreaterThan(LIMIT);
        expect(sizeOf(2n ** BigInt(16 * LIMIT), LIMIT)).toBeGreaterThan(LIMIT);
        expect(sizeOf({ nested: [new Error('x'.repeat(LIMIT))] }, LIMIT)).toBeGreaterThan(LIMIT);
        // positive controls: what the allow-list sizes
        expect(sizeOf({ a: [1, 'two', 3n, null, undefined, true], d: new Date(0), m: new Map([[1, 2]]), s: new Set([1]), b: new Uint8Array(10) }, LIMIT)).toBeLessThan(1024);
        expect(sizeOf(new RegExp('a'), LIMIT)).toBeLessThan(1024);
    });

    it("a result is measured on the snapshot that is posted: a getter that reads small to the measure cannot post a large value", async () => {
        const answers: any[] = [];
        const broker = createBroker(() => {}, { sizeOf: createSizeOf(), timeoutMs: 0 });
        let reads = 0;
        broker.expose('twoFaced', () => ({ get x() { reads++; return reads === 1 ? 'small' : 'x'.repeat(RPC_MAX_BYTES); } }));
        broker.handleMessage({ type: 'RPC_REQ', id: 1, method: 'twoFaced', args: [] }, (frame) => answers.push(structuredClone(frame)));
        await vi.waitFor(() => expect(answers).toHaveLength(1));
        expect(createSizeOf()(answers[0], Infinity)).toBeLessThanOrEqual(RPC_MAX_BYTES + 1024);
        expect(reads).toBe(1);
    });

    it('the receiving side re-measures with the same allow-list: a response holding a large Error is refused, not resolved', async () => {
        const sent: any[] = [];
        const broker = createBroker((frame) => sent.push(frame), { sizeOf: createSizeOf(), timeoutMs: 0 });
        const pending = broker.call('m');
        broker.handleMessage({ type: 'RPC_RES', id: sent[0].id, ok: true, value: new Error('x'.repeat(RPC_MAX_BYTES)) });
        await expect(pending).rejects.toMatchObject({ code: 'RESULT_NOT_TRANSFERABLE' });
    });

    it('a log argument is measured as the snapshot the line carries: a large RegExp crosses as a string saying so', () => {
        const { console } = recordingConsole();
        const { lines } = strictComms(console);
        console.log(new RegExp('a'.repeat(2 * LIMIT)));
        expect(lines()[0]!.args[0]).toMatch(/past the log line's byte budget/);
    });
});

describe('C-4: a view operation costs what it changes, not the size of the whole view', () => {
    const originalWorker = (globalThis as any).Worker;
    afterEach(() => {
        (globalThis as any).Worker = originalWorker;
        delete (globalThis as any).__sandboxViewRuns;
        document.body.replaceChildren();
    });

    it('set({ value }) and text() on a view of ~1 M characters serialize a bounded amount each, not the whole body', async () => {
        // the real platform for the view (jsdom's), not the stand-ins above
        for (const name of Object.keys(PLATFORM)) (globalThis as any)[name] = originals[name];
        (globalThis as any).addEventListener = originalAddEventListener;
        const workers: { transfer: MessagePort[] }[] = [];
        (globalThis as any).Worker = class {
            onerror: unknown = null;
            constructor() { workers.push({ transfer: [] }); }
            postMessage(_message: unknown, transfer: MessagePort[]) { workers[workers.length - 1]!.transfer = transfer; }
        };
        // every character the view serializes, through the getters it captures
        let serialized = 0;
        const inner = Object.getOwnPropertyDescriptor(Element.prototype, 'innerHTML')!;
        const outer = Object.getOwnPropertyDescriptor(Element.prototype, 'outerHTML')!;
        Object.defineProperty(Element.prototype, 'innerHTML', { ...inner, get() { const text = inner.get!.call(this); serialized += text.length; return text; } });
        Object.defineProperty(Element.prototype, 'outerHTML', { ...outer, get() { const text = outer.get!.call(this); serialized += text.length; return text; } });
        try {
            const options = { ...VIEW_OPTIONS, renderRate: 1e12 }; // the rate is not what this measures
            new Function(viewBootstrapSource(options))();
            const a = new MessageChannel(), b = new MessageChannel();
            window.dispatchEvent(new MessageEvent('message', { data: { type: 'INIT_VIEW', workerSource: 'void 0', viewFiles: [], html: '<div id="b0"></div><div id="b1"></div><div id="b2"></div><input id="in"><p id="t"></p>' }, source: window, ports: [a.port1, b.port1] }));
            const render = workers[0]!.transfer[1]!;
            const acks: unknown[] = [];
            render.onmessage = (event) => { if (event.data.type === 'VIEW_ACK') acks.push(event.data); };
            render.postMessage({ type: 'VIEW_STARTED', entryErrors: 0 });
            const until = async (count: number) => {
                for (let i = 0; i < 500 && acks.length < count; i++) await new Promise(resolve => setTimeout(resolve, 5));
                expect(acks).toHaveLength(count);
            };
            for (let i = 0; i < 3; i++) {
                render.postMessage({ type: 'VIEW_RENDER', html: `<p>${'y'.repeat(250000)}</p>`, into: `b${i}` });
                await until(i + 1);
            }
            expect(document.body.innerHTML.length).toBeGreaterThan(740000);
            serialized = 0;
            const OPS = 20;
            for (let i = 0; i < OPS; i++) {
                render.postMessage(i % 2 ? { type: 'VIEW_SET', id: 'in', value: 'v' + i } : { type: 'VIEW_TEXT', into: 't', text: 't' + i });
                await until(4 + i);
            }
            expect((document.getElementById('in') as HTMLInputElement).value).toBe('v19');
            expect(document.getElementById('t')!.textContent).toBe('t18');
            expect(serialized).toBeLessThan(OPS * 1000);
            render.close();
        } finally {
            Object.defineProperty(Element.prototype, 'innerHTML', inner);
            Object.defineProperty(Element.prototype, 'outerHTML', outer);
        }
    });
});

describe("C-7: setConfig()'s equal-config check is linear in the config, shared references included", () => {
    it('a config sharing one object 18 levels deep is compared once per pair of objects; the same config still rebuilds nothing', () => {
        defineWebSandbox();
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const el = document.createElement('web-sandbox') as any;
        document.body.appendChild(el);
        let shared: Record<string, unknown> = { leaf: 1 };
        for (let i = 0; i < 18; i++) shared = { a: shared, b: shared };
        const config = { mode: 'cooperative', capabilities: ['allow-scripts'], data: shared };
        el.setConfig(config);
        const frame = el.shadowRoot.querySelector('iframe');
        const keys = vi.spyOn(Object, 'keys');
        el.setConfig(config);
        expect(keys.mock.calls.length).toBeLessThan(1000); // one per compared pair: 2^18 before
        expect(el.shadowRoot.querySelector('iframe')).toBe(frame); // the same config: no rebuild (R3-7 still holds)
        keys.mockRestore();
        el.remove();
    });

    // Sized from the cap, not by a constant far past it (backlog T6): a config of `wide` objects is compared in wide + 3
    // pairs (the config, its capabilities, `data`, then one per object). Before, 200 000 objects, 20 times the cap. The
    // comparison stops at the cap either way, but each setConfig() structured-clones the whole config, so the test spent
    // its time (2.2 s in a full idle run, 4.2 s with two busy loops on the machine) building and cloning 200 000 objects
    // that decide nothing, and a loaded machine took it past vitest's 5 s. Now it tests both sides of the cap. The control,
    // just within the cap, rebuilds nothing, so the rebuild past it is the cap's doing (0.2–0.5 s in full runs, idle or
    // loaded).
    it('past the comparison cap the configs count as different: the sandbox rebuilds (the safe answer)', () => {
        defineWebSandbox();
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const setTwice = (wide: number) => {
            const el = document.createElement('web-sandbox') as any;
            document.body.appendChild(el);
            const data: Record<string, unknown> = {};
            for (let i = 0; i < wide; i++) data['k' + i] = { i };
            const config = { mode: 'cooperative', capabilities: ['allow-scripts'], data };
            el.setConfig(config);
            const frame = el.shadowRoot.querySelector('iframe');
            el.setConfig(config);
            const rebuilt = el.shadowRoot.querySelector('iframe') !== frame;
            el.remove();
            return rebuilt;
        };
        expect(setTwice(SAME_DATA_MAX_PAIRS - 3)).toBe(false); // the control: SAME_DATA_MAX_PAIRS pairs, all compared
        expect(setTwice(2 * SAME_DATA_MAX_PAIRS)).toBe(true);
    });
});

describe('C-9: coalescing a render keeps the order of the operations that remain', () => {
    // The prelude against stand-ins of the platform it captures, passed in by name, so the test can deliver a trusted
    // INIT_WORKER and read what is posted on the render port in order.
    function startPrelude() {
        const listeners = new Map<object, Record<string, (event: any) => void>>();
        class Target {
            addEventListener(type: string, listener: (event: any) => void) {
                const own = listeners.get(this) ?? {};
                own[type] = listener;
                listeners.set(this, own);
            }
        }
        class Port extends Target {
            posted: any[] = [];
            postMessage(message: unknown) { this.posted.push(structuredClone(message)); }
            start() {}
        }
        class Ev {
            constructor(readonly init: { data?: unknown; ports?: unknown[] }) {}
            get isTrusted() { return true; }
            stopImmediatePropagation() {}
            preventDefault() {}
            get defaultPrevented() { return false; }
        }
        class MsgEv extends Ev {
            get data() { return this.init.data; }
            get ports() { return this.init.ports ?? []; }
        }
        const w = new Target() as any;
        w.URL = {};
        w.queueMicrotask = queueMicrotask;
        const run = new Function('globalThis', 'EventTarget', 'MessagePort', 'MessageEvent', 'Event', `return (${inStrictWorker.toString()})`)(w, Target, Port, MsgEv, Ev);
        run({ attach: () => {}, log: () => {} }, { scriptUnsafe: true, maxRender: 1000, maxTarget: 64, maxElements: 100, maxDepth: 10, maxCharacters: 1000, entryDoneName: '__c9Done', eventTypes: ['click'] });
        const renderPort = new Port();
        listeners.get(w)!['message']!(new MsgEv({ data: { type: 'INIT_WORKER' }, ports: [new Port(), renderPort] }));
        const ack = () => listeners.get(renderPort)!['message']!(new MsgEv({ data: { type: 'VIEW_ACK' } }));
        return { view: w.sandboxView, renderPort, ack };
    }

    it('[render A into x, set y, render B into x] is applied as [set y, render B]: the set is never moved after B', () => {
        const { view, renderPort, ack } = startPrelude();
        view.render('<p>first</p>', 'root'); // in flight at once
        view.render('<p id="y">A</p>', 'x');
        view.set('y', { value: 'v' });
        view.render('<p>B</p>', 'x');
        for (let i = 0; i < 3; i++) ack();
        const operations = renderPort.posted.filter((m: any) => m.type === 'VIEW_RENDER' || m.type === 'VIEW_SET');
        expect(operations.map((m: any) => (m.type === 'VIEW_RENDER' ? `render ${m.html}` : `set ${m.id}`))).toEqual(['render <p>first</p>', 'set y', 'render <p>B</p>']);
    });
});

describe('C-11: only real import and export specifiers are rewritten in the declarations', () => {
    it('a specifier quoted in a comment or a string is left as it is; real ones get their .js extension', () => {
        const root = process.cwd(); // vitest runs from the repository root
        mkdirSync(join(root, 'out'), { recursive: true });
        const work = mkdtempSync(join(root, 'out', 'c11-'));
        try {
            mkdirSync(join(work, 'scripts'));
            mkdirSync(join(work, 'dist', 'lib'), { recursive: true });
            for (const name of ['declaration-specifiers.ts', 'js-tokens.ts']) {
                try { copyFileSync(join(root, 'scripts', name), join(work, 'scripts', name)); } catch { /* js-tokens.ts is new */ }
            }
            writeFileSync(join(work, 'dist', 'lib', 'a.d.ts'), 'export type A = 1;\n');
            const index = [
                '/** Example: `import { A } from "./nowhere"` or `import("./nowhere/either")`. */',
                'import type { A } from "./lib/a";',
                'export { type A as B } from \'./lib/a\';',
                'export type C = import("./lib/a").A;',
                '// export * from "./also-nowhere";',
                'export declare const text: "from \\"./not-a-specifier\\"";',
                '',
            ].join('\n');
            writeFileSync(join(work, 'dist', 'index.d.ts'), index);
            execFileSync('bun', [join(work, 'scripts', 'declaration-specifiers.ts')], { stdio: 'pipe' });
            expect(readFileSync(join(work, 'dist', 'index.d.ts'), 'utf8')).toBe(index
                .replace('import type { A } from "./lib/a"', 'import type { A } from "./lib/a.js"')
                .replace("from './lib/a'", "from './lib/a.js'")
                .replace('import("./lib/a")', 'import("./lib/a.js")'));
        } finally {
            rmSync(work, { recursive: true, force: true });
        }
    });
});

describe("M-1, M-2: the relay's own lines always reach the host, and its budgets fit the host's window by construction", () => {
    // The host side: the element, with a port of its own, dispatching what the guest's relay posted on it.
    function hostOf() {
        defineWebSandbox();
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const el = document.createElement('web-sandbox') as any;
        document.body.appendChild(el);
        el.setConfig({ mode: 'cooperative', capabilities: ['allow-scripts'] });
        const dispatched: string[] = [];
        el.addEventListener('sandbox-log', (event: CustomEvent) => dispatched.push(String(event.detail.args[0])));
        // a fresh environment's limits each time, on a port of its own
        const deliver = (frames: unknown[]) => {
            dispatched.length = 0;
            el._teardown();
            const { port1 } = new MessageChannel();
            el._port = port1;
            for (const frame of frames) el._onGuestMessage(port1, () => {}, frame, null);
            port1.close();
            return dispatched;
        };
        return { deliver, done: () => el.remove() };
    }
    const withPlatform = <T>(platform: Record<string, unknown>, run: () => T): T => {
        const saved: Record<string, unknown> = {};
        for (const name of Object.keys(PLATFORM)) {
            saved[name] = (globalThis as any)[name];
            (globalThis as any)[name] = platform[name];
        }
        try {
            return run();
        } finally {
            for (const name of Object.keys(PLATFORM)) (globalThis as any)[name] = saved[name];
        }
    };

    it('M-1: a burst of 1 001 lines after ready: 1 000 lines and the warning that the guest started dropping all arrive', () => {
        vi.spyOn(performance, 'now').mockImplementation(() => 1000);
        const { console } = recordingConsole();
        const { port } = strictComms(console);
        for (let i = 0; i < LOG_EVENTS_PER_SECOND + 1; i++) console.log('line ' + i);
        const frames = port.frames.filter(frame => frame.type === 'LOG');
        const host = withPlatform(originals, hostOf);
        const dispatched = withPlatform(originals, () => host.deliver(frames));
        expect(dispatched.filter(line => line.startsWith('line '))).toHaveLength(LOG_EVENTS_PER_SECOND);
        expect(dispatched.filter(line => /lines past that are dropped/.test(line))).toHaveLength(1);
        host.done();
    });

    it("M-2: 1 000 lines before the port is attached all arrive, then '<mode> Ready'; past a cap, the warning names the cap that was reached", () => {
        vi.spyOn(performance, 'now').mockImplementation(() => 1000);
        const host = withPlatform(originals, hostOf);
        // a line of one short string, or of 900 000 bytes (within LOG_MAX_BYTES; five of them are past 4 MiB)
        const cases = [[LOG_EVENTS_PER_SECOND, () => 'x', null], [LOG_EVENTS_PER_SECOND + 1, () => 'x', '1000 lines'], [6, () => new Uint8Array(900000), '4194304 bytes']] as const;
        for (const [count, value, cap] of cases) {
            const { console } = recordingConsole();
            const comms = inSandboxScript(false, 'strict', console, createBroker, { externalPort: true }, createSizeOf);
            for (let i = 0; i < count; i++) console.log(value());
            const port = new ClonePort();
            comms.attach(port as any);
            const dispatched = withPlatform(originals, () => host.deliver(port.frames));
            expect(dispatched.filter(line => line === 'strict Ready'), `${count} lines`).toHaveLength(1);
            const warning = dispatched.filter(line => /logged before the sandbox was connected were dropped/.test(line));
            if (cap === null) expect(warning).toEqual([]);
            else expect(warning.length === 1 && warning[0]!.includes(cap), `${count} lines: ${warning}`).toBe(true);
        }
        host.done();
    });
});

describe("M-5: in a worker (worker and strict mode) the relay is the only sink: nothing goes to the worker's own console", () => {
    it('strict: a line, a cut line and console.count reach the host only; cooperative: the browser console still gets them, bounded', () => {
        const strict = recordingConsole();
        const { lines } = strictComms(strict.console);
        strict.console.log('hello');
        strict.console.log('x'.repeat(LOG_MAX_STRING + 1));
        (strict.console as any).count('n');
        expect(lines()).toHaveLength(2);
        expect(strict.calls).toEqual([]);
        const cooperative = recordingConsole();
        inSandboxScript(false, 'cooperative', cooperative.console, createBroker, undefined, createSizeOf);
        cooperative.console.log('hello');
        expect(cooperative.calls).toEqual([['log', ['hello']]]);
    });
});
