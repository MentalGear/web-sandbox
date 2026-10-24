import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineWebSandbox } from '@src/host';
import { ENVIRONMENT_FIELDS, ENVIRONMENT_RELEASES, releaseEnvironment, type DetachedEnvironment, type EnvironmentField } from '@src/lib/environment';
import { SyntaxKind, tokenize, type Token } from '../../scripts/js-tokens';
import { checkIn } from './check-in';

/**
 * Class L (S74; LM-2): embedder code that runs inside a release of the element's own teardown. Removing a frame fires
 * the host window's `focus` on Firefox, and a focused guest's `pagehide` calls `parent.parent.focus()` on every engine;
 * a listener that calls reset(), load() or setConfig() builds again from inside the teardown. The teardown detaches
 * every per-environment field before it releases any (src/lib/environment.ts), so the nested build owns fields the outer
 * teardown never writes. Before: the outer teardown went on to null `_iframe` and close the nested build's bridge, and
 * on Chromium and WebKit its `remove()` threw NotFoundError.
 *
 * Two structural tests, neither written from the cases a review found:
 * - the re-entry matrix: at every release point of the teardown, re-enter with each public call, and check what is left.
 *   The release points are the declared fields (ENVIRONMENT_FIELDS: one hook per field's resource), and every call the
 *   teardown makes to the platform's `remove()` and `MessagePort.close()` (counted, then each one in turn);
 * - a scan of the source: `_teardown` writes no `this._` field after its first call into anything else.
 * The e2e half, with a real focus event: test/e2e/teardown-reentry.spec.ts.
 */

defineWebSandbox();

afterEach(() => {
    vi.restoreAllMocks();
    document.body.replaceChildren();
});

const CONFIG = {
    mode: 'cooperative', capabilities: ['allow-scripts'], html: '<p>x</p>',
    fetchBridge: { allow: ['https://example.com'] }, autoResize: true, watchdogTimeout: 60_000,
};

const stub = { stop() {}, handlePong() {} };
// A stand-in for each resource a ready cooperative element does not hold, so that every declared field is in the matrix
// (a Record: a field added to the list without an entry here does not compile).
const SEEDS: { [K in EnvironmentField]: () => unknown } = {
    _stopListening: () => () => {},
    _loadDeadline: () => ({ ...stub }),
    _iframe: () => document.createElement('iframe'),
    _port: () => new MessageChannel().port1,
    _viewPort: () => new MessageChannel().port1,
    _viewWatchdog: () => ({ ...stub }),
    _watchdog: () => ({ ...stub }),
    _resizer: () => ({ report() {}, stop() {} }),
    _fetchBridge: () => ({ abortAll() {} }),
    _bridgeFrame: () => ({ close() {} }),
    _viewWrites: () => new Map([[1, { shown() {}, lost() {} }]]),
    _executionTimers: () => new Set([{ cancel() {} }]),
    _executionProbes: () => new Map([[-1, () => {}]]),
};

const isEmpty = (value: unknown) => value === null || ((value instanceof Map || value instanceof Set) && value.size === 0);

function ready(seed: boolean) {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const el = document.createElement('web-sandbox') as any;
    document.body.appendChild(el);
    el.setConfig(CONFIG);
    const { port1 } = new MessageChannel();
    const closed = vi.spyOn(port1, 'close');
    checkIn(el, port1);
    expect(el.state).toBe('ready');
    if (seed) for (const field of ENVIRONMENT_FIELDS) if (isEmpty(el[field])) {
        const value = SEEDS[field]();
        if (el[field] instanceof Map) for (const [key, entry] of value as Map<unknown, unknown>) el[field].set(key, entry);
        else if (el[field] instanceof Set) for (const entry of value as Set<unknown>) el[field].add(entry);
        else el[field] = value;
    }
    return { el, port: port1, closed };
}

const RELEASE_METHODS = ['stop', 'abortAll', 'close', 'cancel', 'lost', 'remove'];

/** Makes the release of `field`'s resource call `before` first: a function is wrapped, an object's release methods are. */
function hookRelease(el: any, field: EnvironmentField, before: () => void): void {
    const wrap = <F extends (...args: any[]) => unknown>(original: F) =>
        function (this: unknown, ...args: unknown[]) { before(); return original.apply(this, args); } as unknown as F;
    const wrapMethods = (target: any) => {
        for (const name of RELEASE_METHODS) if (typeof target[name] === 'function') target[name] = wrap(target[name].bind(target));
    };
    const value = el[field];
    if (value instanceof Map) {
        for (const [key, entry] of value) {
            if (typeof entry === 'function') value.set(key, wrap(entry));
            else wrapMethods(entry);
        }
    } else if (value instanceof Set) {
        for (const entry of value) wrapMethods(entry);
    } else if (typeof value === 'function') {
        el[field] = wrap(value);
    } else {
        wrapMethods(value);
    }
}

const CALLS = ['reset', 'setConfig', 'load', 'terminate'] as const;
type Call = typeof CALLS[number];

const reenterWith = (el: any, call: Call) => () => {
    if (call === 'reset') el.reset();
    else if (call === 'setConfig') el.setConfig(CONFIG);
    else if (call === 'load') el.load('<p>y</p>');
    else el.terminate('inner');
};

const frames = (el: any) => [...el.shadowRoot.querySelectorAll('iframe')] as HTMLIFrameElement[];

/** What must hold once the outer terminate() returned, for a build or a termination started inside one of its releases. */
function expectOneEnvironment(el: any, call: Call, old: { wrapper: HTMLIFrameElement; bridge: HTMLIFrameElement; held: Record<string, unknown> }) {
    expect(old.wrapper.isConnected).toBe(false);
    expect(old.bridge.isConnected).toBe(false);
    if (call === 'terminate') {
        expect(el.state).toBe('terminated');
        expect(frames(el)).toEqual([]);
        for (const field of ENVIRONMENT_FIELDS) expect(isEmpty(el[field]), field).toBe(true);
        return;
    }
    expect(el.state).toBe('loading');
    const now = frames(el);
    expect(now.length).toBe(2); // the wrapper and the bridge's frame of the one environment
    expect(now.every((frame) => frame.isConnected)).toBe(true);
    expect(now).toContain(el._iframe);
    expect(el._iframe).not.toBe(old.wrapper);
    expect(now).not.toContain(old.wrapper);
    expect(now).not.toContain(old.bridge);
    for (const field of ENVIRONMENT_FIELDS) {
        const value = el[field];
        if (value instanceof Map || value instanceof Set) expect(value.size, field).toBe(0); // the old environment's entries are gone
        else if (value !== null) expect(value, `${field} is the nested build's own`).not.toBe(old.held[field]);
    }
    for (const field of ['_iframe', '_bridgeFrame', '_fetchBridge', '_loadDeadline', '_stopListening'] as const) {
        expect(el[field], `${field} of the nested environment`).not.toBeNull();
    }
    el.terminate('last'); // the next terminate() ends the nested environment: no frame is left behind
    expect(frames(el)).toEqual([]);
    for (const field of ENVIRONMENT_FIELDS) expect(isEmpty(el[field]), `${field} after the last terminate()`).toBe(true);
}

const oldEnvironment = (el: any) => ({
    wrapper: el._iframe as HTMLIFrameElement,
    bridge: el.shadowRoot.querySelector('iframe[aria-hidden="true"]') as HTMLIFrameElement,
    held: Object.fromEntries(ENVIRONMENT_FIELDS.map((field) => [field, el[field]])),
});

describe('the declared list', () => {
    it('has a release for every field and the list is the release order', () => {
        expect(ENVIRONMENT_FIELDS).toEqual(Object.keys(ENVIRONMENT_RELEASES));
        expect(ENVIRONMENT_FIELDS.length).toBeGreaterThan(0);
        expect(Object.keys(SEEDS).sort()).toEqual([...ENVIRONMENT_FIELDS].sort());
        const { el } = ready(true);
        for (const field of ENVIRONMENT_FIELDS) expect(isEmpty(el[field]), `${field} is held in the matrix`).toBe(false);
    });

    it('the frames are released last: the platform runs embedder code there', () => {
        expect(ENVIRONMENT_FIELDS.slice(-2)).toEqual(['_iframe', '_bridgeFrame']);
    });
});

describe('re-entry at each declared release point of _teardown', () => {
    for (const field of ENVIRONMENT_FIELDS) for (const call of CALLS) {
        it(`${field} -> ${call}()`, () => {
            const { el, closed } = ready(true);
            const old = oldEnvironment(el);
            let fired = 0;
            let armed = true;
            const before = () => {
                if (!armed) return;
                armed = false;
                fired++;
                reenterWith(el, call)();
            };
            hookRelease(el, field, before);
            el.terminate('outer');
            expect(fired, 'the release point ran embedder code').toBe(1);
            expect(closed, 'the old guest\'s port is closed').toHaveBeenCalled();
            expectOneEnvironment(el, call, old);
        });
    }
});

describe('re-entry at every platform call the teardown makes', () => {
    const proto = {
        remove: Element.prototype.remove,
        close: Object.getPrototypeOf(new MessageChannel().port1).close as () => void,
    };
    const portProto = Object.getPrototypeOf(new MessageChannel().port1);

    // Counts the calls first (a dry run), then re-enters at each one in turn.
    const run = (at: number | null, call: Call) => {
        const { el, closed } = ready(false);
        const old = oldEnvironment(el);
        let calls = 0;
        let fired = false;
        const reenter = reenterWith(el, call);
        const point = () => {
            if (at !== null && !fired && calls++ === at) { fired = true; reenter(); } else if (at === null) calls++;
        };
        vi.spyOn(Element.prototype, 'remove').mockImplementation(function (this: Element) { point(); proto.remove.call(this); });
        vi.spyOn(portProto, 'close').mockImplementation(function (this: MessagePort) { point(); proto.close.call(this); });
        el.terminate('outer');
        vi.restoreAllMocks();
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        return { el, old, calls, fired, closed };
    };

    it('the teardown makes platform calls', () => {
        const { calls } = run(null, 'reset');
        expect(calls).toBeGreaterThanOrEqual(3); // the wrapper, the bridge's frame and the guest's port at least
        document.body.replaceChildren();
    });

    for (const call of CALLS) {
        it(`each remove() and close() -> ${call}()`, () => {
            const { calls } = run(null, call);
            document.body.replaceChildren();
            for (let at = 0; at < calls; at++) {
                const result = run(at, call);
                expect(result.fired, `call ${at} of ${calls}`).toBe(true);
                expect(result.closed, `call ${at}: the old guest's port is closed`).toHaveBeenCalled();
                expectOneEnvironment(result.el, call, result.old);
                document.body.replaceChildren();
            }
        });
    }
});

describe('a node already detached by embedder code is not an error (NotFoundError)', () => {
    it('terminate() returns when the wrapper left the shadow root before its remove()', () => {
        const { el } = ready(false);
        const wrapper = el._iframe as HTMLIFrameElement;
        const remove = Element.prototype.remove;
        vi.spyOn(wrapper, 'remove').mockImplementation(function (this: Element) {
            remove.call(this);
            throw new DOMException('The node to be removed is no longer a child of this node.', 'NotFoundError');
        });
        expect(() => el.terminate('x')).not.toThrow();
        expect(el.state).toBe('terminated');
        expect(frames(el)).toEqual([]);
    });

    it('and any other error of a release still comes out, after the rest has been released', () => {
        const { el, closed } = ready(false);
        vi.spyOn(el._iframe, 'remove').mockImplementation(() => { throw new Error('boom'); });
        expect(() => el.terminate('x')).toThrow('boom');
        expect(closed).toHaveBeenCalled();
        expect(el._bridgeFrame).toBeNull();
    });
});

describe('a release that throws does not stop the ones after it (BD3:TST-5, class L)', () => {
    it('releaseEnvironment: the first failure is rethrown once every release has run, the frame removed among them', () => {
        const closed = vi.fn();
        const removed = vi.fn();
        const frame = document.createElement('iframe');
        frame.remove = removed;
        const detached: DetachedEnvironment = [
            ['_stopListening', () => { throw new Error('first'); }],
            ['_port', { close: closed }],
            ['_loadDeadline', { stop() { throw new Error('second'); } }],
            ['_iframe', frame],
        ];
        expect(() => releaseEnvironment(detached)).toThrow('first');
        expect(closed).toHaveBeenCalledTimes(1);
        expect(removed).toHaveBeenCalledTimes(1);
    });

    it('the element: a listener the first release stops that throws leaves no port open, no frame in the document and no bridge', () => {
        const { el, closed } = ready(false);
        el._stopListening = () => { throw new Error('first release'); };
        expect(() => el.terminate('x')).toThrow('first release');
        expect(closed).toHaveBeenCalled();
        expect(frames(el)).toEqual([]);
        expect(el._bridgeFrame).toBeNull();
        expect(el.state).toBe('terminated');
    });

    it('the wrapper\'s load handler is detached before the frame is removed, so a load that the removal causes finds none', () => {
        const frame = document.createElement('iframe');
        frame.onload = () => {};
        frame.remove = () => { throw new Error('boom'); };
        expect(() => ENVIRONMENT_RELEASES._iframe(frame)).toThrow('boom');
        expect(frame.onload).toBeNull();
    });
});

// ---- the source scan ----
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** The tokens of the body of the method `name` (past its `{`, up to its `}`), from a class member definition. */
function methodBody(source: string, name: string): Token[] {
    const tokens = tokenize(source);
    const at = tokens.findIndex((token, i) => token.text === name && tokens[i - 1]?.kind === SyntaxKind.PrivateKeyword && tokens[i + 1]?.kind === SyntaxKind.OpenParenToken);
    if (at < 0) throw new Error(`no method ${name}`);
    let i = at + 1;
    while (tokens[i]!.kind !== SyntaxKind.OpenBraceToken) i++;
    let depth = 0;
    for (let j = i; j < tokens.length; j++) {
        if (tokens[j]!.kind === SyntaxKind.OpenBraceToken) depth++;
        if (tokens[j]!.kind === SyntaxKind.CloseBraceToken && --depth === 0) return tokens.slice(i + 1, j);
    }
    throw new Error(`unbalanced in ${name}`);
}

// Calls that run no platform code: library constructors of plain objects, and the collection clear.
const PURE_CALLS = new Set(['createLogLimiter', 'createRateLimiter', 'detachEnvironment', 'clear']);
const MUTATORS = new Set(['clear', 'set', 'delete', 'add', 'push', 'pop', 'splice', 'shift', 'unshift']);
const ASSIGNMENTS = new Set(['=', '+=', '-=', '*=', '||=', '&&=', '??=', '++', '--']);

/** The writes to `this._…` fields after the first call that is not pure (what a release is), as `text@offset`. */
function writesAfterFirstRelease(body: Token[]): { writes: string[]; sawWriteBefore: boolean; sawRelease: boolean } {
    let released = false;
    let sawWriteBefore = false;
    const writes: string[] = [];
    for (let i = 0; i < body.length; i++) {
        const token = body[i]!;
        if (body[i + 1]?.kind === SyntaxKind.OpenParenToken && token.kind === SyntaxKind.Identifier && !PURE_CALLS.has(token.text)) released = true;
        if (token.kind !== SyntaxKind.ThisKeyword || body[i + 1]?.kind !== SyntaxKind.DotToken) continue;
        const field = body[i + 2];
        if (!field || !field.text.startsWith('_')) continue;
        const next = body[i + 3];
        const mutates = (next && ASSIGNMENTS.has(next.text))
            || (next?.kind === SyntaxKind.DotToken && MUTATORS.has(body[i + 4]?.text ?? '') && body[i + 5]?.kind === SyntaxKind.OpenParenToken);
        if (!mutates) continue;
        if (released) writes.push(`this.${field.text}@${field.start}`);
        else sawWriteBefore = true;
    }
    return { writes, sawWriteBefore, sawRelease: released };
}

describe('_teardown: no write to the element after the first release', () => {
    it('host.ts: every this._ write is before the first call that can run platform code', () => {
        const body = methodBody(readFileSync(path.join(ROOT, 'src/host.ts'), 'utf8'), '_teardown');
        const scan = writesAfterFirstRelease(body);
        expect(scan.sawWriteBefore, 'the scan sees the writes it is about').toBe(true);
        expect(scan.sawRelease, 'and the release').toBe(true);
        expect(scan.writes).toEqual([]);
        expect(body.map((token) => token.text)).toContain('detachEnvironment');
    });

    it('the scan fails on a teardown that nulls a field after its release', () => {
        const old = `class A { private _teardown() {
            this._queue = [];
            if (this._iframe) { this._iframe.onload = null; this._iframe.remove(); this._iframe = null; }
            if (this._port) { this._port.close(); this._port = null; }
            this._viewWrites.clear();
        } }`;
        const scan = writesAfterFirstRelease(methodBody(old, '_teardown'));
        expect(scan.writes.length).toBeGreaterThanOrEqual(3);
    });
});
