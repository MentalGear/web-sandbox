import { afterEach, describe, expect, it, vi } from 'vitest';
import { GATE_CANARIES, gatesOf, gateViolations, STARTUP_GATES, takeGateViolations, workerGates, type GateName, type GateRow } from '@src/lib/startup-gates';
import { announcementFinding, verdictFinding } from '@src/lib/startup-verdicts';
import { inSandboxView, VIEW_OPTIONS, viewBootstrapText } from '@src/lib/in-sandbox-view';
import { reasonText, TERMINATION_REASONS } from '@src/lib/reasons';
import { runBootstrap } from './sandbox-environment';

/**
 * The start-up gates' registry (design 03, "The start-up gates"; design 05, row 3.5) and the code derived from it: the
 * view's canaries (inSandboxView) and the worker's (workerGates) are one table each, keyed by the registry's names, and
 * the host reads the verdicts by the same names (startup-verdicts.ts). The canaries themselves are run in the browsers by
 * test/e2e/startup-gates.spec.ts, each under the mutant that provokes it.
 */

const ROWS = Object.entries(STARTUP_GATES) as [GateName, GateRow][];

/** The keys of the object literal `const <name> … = {` in `source`, at its top level. */
function literalKeys(source: string, name: string): string[] {
    const start = source.indexOf(`const ${name}`);
    expect(start, name).toBeGreaterThan(-1);
    const open = source.indexOf('{', source.indexOf('=', start));
    const keys: string[] = [];
    let depth = 0;
    for (let i = open; i < source.length; i++) {
        const char = source[i]!;
        if (char === '{' || char === '(' || char === '[') depth++;
        if (char === '}' || char === ')' || char === ']') depth--;
        if (depth === 0) break;
        if (depth !== 1) continue;
        const key = /^[\s,{]*([A-Za-z]\w*)\s*:/.exec(source.slice(i, i + 64));
        if (key && (char === '{' || char === ',')) keys.push(key[1]!);
    }
    return keys;
}

describe('the registry (STARTUP_GATES)', () => {
    it('each gate has its own reason, a termination the element decides, and the frame canary is not among them', () => {
        const reasons = ROWS.map(([, row]) => row.reason);
        expect(new Set(reasons).size).toBe(reasons.length);
        for (const [name, row] of ROWS) {
            expect(TERMINATION_REASONS[row.reason].decidedBy, name).toBe('host');
            expect(TERMINATION_REASONS[row.reason].text, name).toMatch(/^a start-up gate failed: /);
            expect(row.realms.length, name).toBeGreaterThan(0);
            expect(row.modes.length, name).toBeGreaterThan(0);
        }
        expect(Object.keys(STARTUP_GATES)).not.toContain('frame');
    });

    it("a gate whose canary provokes a policy runs in sealed mode only: strict mode's view inherits the host page's policy, which would report it", () => {
        for (const [name, row] of ROWS) {
            if (row.raises === null) continue;
            expect(row.modes, name).toEqual(['sealed']);
            expect(row.modesWhy, name).toBeTruthy();
        }
        expect(gateViolations()).toEqual(Object.fromEntries(ROWS.filter(([, row]) => row.raises !== null).map(([name, row]) => [name, row.raises])));
    });

    it('the gates of research 31 (Q2), by realm and mode', () => {
        expect(gatesOf('view', 'sealed')).toEqual(['framing', 'stringCode', 'connect', 'image', 'style', 'base', 'cookie', 'storage', 'parent']);
        expect(gatesOf('worker', 'sealed')).toEqual(['opaque', 'stringCode', 'storage', 'allowlist']);
        expect(gatesOf('view', 'strict')).toEqual(['framing', 'cookie', 'storage', 'parent']);
        expect(gatesOf('worker', 'strict')).toEqual(['opaque', 'storage', 'allowlist']);
    });
});

describe('the code is derived from the registry: one canary per gate of each realm, and none other', () => {
    it("the view's canary table (inSandboxView) has exactly the view's gates; the bootstrap is given the registry's lists", () => {
        const all = new Set([...gatesOf('view', 'sealed'), ...gatesOf('view', 'strict')]);
        expect(literalKeys(inSandboxView.toString(), 'canaries').sort()).toEqual([...all].sort());
        expect(VIEW_OPTIONS.gates.view).toEqual({ sealed: gatesOf('view', 'sealed'), strict: gatesOf('view', 'strict') });
        expect(VIEW_OPTIONS.gates.violations).toEqual(gateViolations());
        for (const [key, value] of Object.entries(GATE_CANARIES)) expect((VIEW_OPTIONS as unknown as Record<string, unknown>)[key]).toBe(value);
    });

    it("the worker's canary tables (workerGates, before and after the allowlist) have exactly the worker's gates", () => {
        const source = workerGates.toString();
        const all = new Set([...gatesOf('worker', 'sealed'), ...gatesOf('worker', 'strict')]);
        expect([...literalKeys(source, 'before'), ...literalKeys(source, 'after')].sort()).toEqual([...all].sort());
        expect(literalKeys(source, 'after')).toEqual(['allowlist']);
    });

    it("the worker's source is given the violations of its own mode's gates alone", () => {
        expect(gateViolations(gatesOf('worker', 'sealed'))).toEqual({ stringCode: 'script-src' });
        expect(gateViolations(gatesOf('worker', 'strict'))).toEqual({});
    });
});

/** The names the fake worker's allowlist keeps. */
const KEPT = ['origin', 'Function', 'indexedDB', 'SecurityPolicyViolationEvent', 'Event', 'addEventListener', 'removeEventListener'];

/** A worker's global as the prelude finds it, with each canary's answer chosen. */
function fakeWorker(held: boolean) {
    const posted: unknown[] = [];
    const listeners: [string, (event: any) => void][] = [];
    class Violation {
        readonly isTrusted = true;
        constructor(readonly directive: string) {}
        get effectiveDirective() { return this.directive; }
    }
    const g: any = {
        origin: held ? 'null' : 'https://app.example',
        Function: held ? function () { throw new EvalError('refused'); } : Function,
        indexedDB: { open: () => { if (held) throw new DOMException('opaque', 'SecurityError'); return {}; } },
        SecurityPolicyViolationEvent: Violation,
        Event: { prototype: { stopImmediatePropagation(this: any) { this.stopped = true; } } },
        postMessage: (message: unknown) => posted.push(message),
        addEventListener: (type: string, listener: (event: any) => void) => listeners.push([type, listener]),
        removeEventListener: (type: string, listener: (event: any) => void) => {
            const at = listeners.findIndex(([t, l]) => t === type && l === listener);
            if (at >= 0) listeners.splice(at, 1);
        },
        fetch: () => {}, XMLHttpRequest: class {}, WebSocket: class {}, EventSource: class {}, importScripts: () => {},
    };
    // the allowlist: every own name off KEPT goes, but the one the mutant leaves
    const allowlist = (leave: string | null) => { for (const name of Object.getOwnPropertyNames(g)) if (!KEPT.includes(name) && name !== leave) delete g[name]; };
    return { g, posted, listeners, allowlist, Violation };
}

describe("the worker's gates (workerGates), run as the prelude runs them", () => {
    const names = gatesOf('worker', 'sealed');
    const raises = gateViolations(names);

    it('held: every verdict true, posted as the first message, and nothing thrown', () => {
        const worker = fakeWorker(true);
        const finish = workerGates(worker.g, names, KEPT);
        expect(worker.posted).toEqual([]); // nothing before the allowlist
        worker.allowlist(null);
        finish();
        expect(worker.posted).toEqual([{ type: 'WORKER_VERDICTS', verdicts: Object.fromEntries(names.map(name => [name, true])) }]);
    });

    it('a name the allowlist left (fetch): the verdict is false, posted first, then the script stops, its error cancelled in the worker', () => {
        const worker = fakeWorker(true);
        const finish = workerGates(worker.g, names, KEPT);
        worker.allowlist('fetch');
        expect(finish).toThrow(/a start-up gate of the worker failed/);
        expect((worker.posted[0] as any).verdicts.allowlist).toBe(false);
        const cancel = worker.listeners.find(([type]) => type === 'error')![1];
        const event = { preventDefault: vi.fn() };
        cancel(event);
        expect(event.preventDefault).toHaveBeenCalled();
    });

    it("a worker that is not sandboxed: every canary that needs the worker's names fails", () => {
        const worker = fakeWorker(false);
        const finish = workerGates(worker.g, names, KEPT);
        worker.allowlist(null);
        expect(finish).toThrow();
        expect((worker.posted[0] as any).verdicts).toEqual({ opaque: false, stringCode: false, storage: false, allowlist: true });
    });

    it("the violation its canary raises is taken, once, ahead of the bootstrap's listener; another passes on; the listener leaves once it took it", () => {
        const worker = fakeWorker(true);
        takeGateViolations(worker.g, names, raises);
        const [type, take] = worker.listeners.find(([kind]) => kind === 'securitypolicyviolation')!;
        expect(type).toBe('securitypolicyviolation');
        const other = new worker.Violation('connect-src') as any;
        take(other);
        expect(other.stopped).toBeUndefined();
        const script = new worker.Violation('script-src') as any;
        take(script);
        expect(script.stopped).toBe(true);
        expect(worker.listeners.some(([kind]) => kind === 'securitypolicyviolation')).toBe(false);
    });

    // Firefox's worker does not name the event's class, so the directive's getter is found on the first event read: one
    // the guest dispatched first must not be that event.
    it.each([['names', true], ['does not name', false]])("an event the guest dispatched is not read, where the worker %s the event's class: it is not taken, its getter is not run or kept, and the canary's own event still is", (_label, named) => {
        const worker = fakeWorker(true);
        if (!named) delete worker.g.SecurityPolicyViolationEvent;
        takeGateViolations(worker.g, names, raises);
        const take = worker.listeners.find(([kind]) => kind === 'securitypolicyviolation')![1];
        const read = vi.fn(() => 'script-src');
        const forged: any = Object.create({ get effectiveDirective() { return read(); } }, { isTrusted: { value: false } });
        take(forged);
        const script = new worker.Violation('script-src') as any;
        take(script);
        expect(read).not.toHaveBeenCalled();
        expect(forged.stopped).toBeUndefined();
        expect(script.stopped).toBe(true);
    });

    it("a mode whose worker's gates raise nothing installs no listener", () => {
        const worker = fakeWorker(true);
        takeGateViolations(worker.g, gatesOf('worker', 'strict'), gateViolations(gatesOf('worker', 'strict')));
        expect(worker.listeners).toEqual([]);
    });
});

describe('the host reads the verdicts by its own registry (startup-verdicts.ts)', () => {
    const allHeld = (realm: 'view' | 'worker', mode: 'sealed' | 'strict') => Object.fromEntries(gatesOf(realm, mode).map(name => [name, true]));

    it('all held: no finding; a missing, false or non-boolean verdict: the first such gate\'s reason, in the registry\'s order', () => {
        expect(verdictFinding(allHeld('view', 'sealed'), 'view', 'sealed')).toBeNull();
        expect(verdictFinding({ ...allHeld('view', 'sealed'), connect: false, base: false }, 'view', 'sealed')).toBe(reasonText('gateConnect'));
        expect(verdictFinding({ ...allHeld('view', 'sealed'), image: 'true' }, 'view', 'sealed')).toBe(reasonText('gateImage'));
        const { opaque: _, ...noOpaque } = allHeld('worker', 'sealed');
        expect(verdictFinding(noOpaque, 'worker', 'sealed')).toBe(reasonText('gateOpaque'));
        expect(verdictFinding(null, 'worker', 'strict')).toBe(reasonText('gateOpaque'));
        // strict mode reads strict mode's gates only: a sealed-only verdict, even false, is not read
        expect(verdictFinding({ ...allHeld('view', 'strict'), stringCode: false }, 'view', 'strict')).toBeNull();
        // a verdict on the prototype is not the view's
        expect(verdictFinding(Object.create(allHeld('view', 'strict')), 'view', 'strict')).toBe(reasonText('gateFraming'));
    });

    it("the version first, then the verdicts; strict mode's view states none and is not asked for one", () => {
        const verdicts = allHeld('view', 'sealed');
        expect(announcementFinding({ version: 'v1', verdicts }, 'sealed', 'v1')).toBeNull();
        expect(announcementFinding({ version: 'v2', verdicts: {} }, 'sealed', 'v1')).toBe(reasonText('documentVersion'));
        expect(announcementFinding({ verdicts }, 'sealed', 'v1')).toBe(reasonText('documentVersion'));
        expect(announcementFinding({ version: 'v1', verdicts: {} }, 'sealed', 'v1')).toBe(reasonText('gateFraming'));
        expect(announcementFinding({ version: null, verdicts: allHeld('view', 'strict') }, 'strict', null)).toBeNull();
    });
});

describe("the view's gates in jsdom's document, which reads as a sandbox document's (sandbox-environment.ts) but is top-level, and keeps cookies and storage", () => {
    afterEach(() => {
        delete (globalThis as any).__sandboxViewRuns;
        vi.restoreAllMocks();
    });

    it('framing, cookie, storage and parent fail (strict mode\'s gates: no version stated), and the announcement says so, synchronously, by name only', () => {
        const announced = vi.spyOn(window, 'postMessage').mockImplementation(() => {});
        runBootstrap(viewBootstrapText());
        expect(announced).toHaveBeenCalledTimes(1);
        const [message] = announced.mock.calls[0]! as [{ verdicts: Record<string, boolean> }];
        expect(message.verdicts).toEqual({ framing: false, cookie: false, storage: false, parent: false });
        expect(announcementFinding(message, 'strict', null)).toBe(reasonText('gateFraming'));
    });
});
