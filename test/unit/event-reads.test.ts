import { describe, it, expect } from 'vitest';
import { eventReads, SAFE_EVENT_READS } from './event-read-scan';
import { stringifiedFor } from './stringified';

/**
 * Class G (docs/research/18_finding_classes/README.md, "One reader for guest values at the boundary"; BD1:TST-1, S80):
 * a listener of a guest realm reads its event only through the getters captured before guest code runs (readEvent, the
 * captured `data` and `ports` getters, the strict prelude's `errorEventMessage`), never as a member of the event, whose
 * accessors the guest can replace (`PromiseRejectionEvent.prototype.reason`, `ErrorEvent.prototype.message`). The scan
 * (test/unit/event-read-scan.ts) finds every listener by its registration, never by what its parameter is called. What
 * the listeners do with the values they read is tested where the listeners are (test/unit/egress.test.ts, and
 * test/e2e/uncaught-event-reads.spec.ts in the browsers).
 */

const GUEST_REALM_FUNCTIONS = await stringifiedFor('capture');

describe('every listener of the guest realms reads its event only through the captured getters', () => {
    it.each(GUEST_REALM_FUNCTIONS)('%s: no member read of an event, and every registration is one the scan follows', (_name, fn) => {
        expect(eventReads(fn.toString()).findings).toEqual([]);
    });

    it('the scan sees the bootstrap\'s and the strict prelude\'s listeners (it is not vacuous on the real code)', () => {
        const reports = Object.fromEntries(GUEST_REALM_FUNCTIONS.map(([name, fn]) => [name, eventReads(fn.toString())]));
        expect(reports.inSandboxScript!.sites).toBeGreaterThan(0);
        expect(reports.inSandboxScript!.handlers).toBeGreaterThan(0);
        expect(reports.inStrictWorker!.sites).toBeGreaterThan(0);
        expect(reports.inStrictWorker!.handlers).toBeGreaterThan(0);
    });

    it('only isTrusted, the platform\'s own unforgeable property of an event, is read as a member', () => {
        expect([...SAFE_EVENT_READS]).toEqual(['isTrusted']);
    });
});

describe('positive controls on the real code: the mutants of BD1:TST-1, applied to the bootstrap\'s text', () => {
    const bootstrap = GUEST_REALM_FUNCTIONS.find(([name]) => name === 'inSandboxScript')![1].toString();
    const mutate = (from: RegExp, to: string) => {
        const mutated = bootstrap.replace(from, to);
        expect(mutated, `the text has the line the mutant changes: ${from}`).not.toBe(bootstrap);
        return eventReads(mutated).findings;
    };

    it('the unhandledrejection listener reading `reason` from the event itself (R5:N-2)', () => {
        expect(mutate(/reportOf\(readEvent\(event, "rejection"\)\.reason\)/, 'reportOf(event.reason)')).toEqual([expect.stringContaining('event.reason')]);
    });

    it('the error listener reading `message` and `error` from the event itself (R5:N-2, R5:N-6)', () => {
        const findings = mutate(/const read = readEvent\(event, "error"\);\s*const message = read\.message;\s*const error = read\.error;/, 'const message = event.message; const error = event.error;');
        expect(findings).toEqual([expect.stringContaining('event.message'), expect.stringContaining('event.error')]);
    });

    it('the same, in a listener whose parameter has another name', () => {
        const renamed = /return \(event\) => \{(\s*let report = \{ text: "a rejection", characters: 0 \};\s*try \{\s*)report = reportOf\(readEvent\(event, "rejection"\)\.reason\)/;
        expect(mutate(renamed, 'return (spoofable) => {$1report = reportOf(spoofable.reason)')).toEqual([expect.stringContaining('spoofable.reason')]);
    });
});

describe('positive controls: each shape of read is found, whatever the parameter is called', () => {
    const found = (source: string) => eventReads(source).findings.map(line => line.slice(line.indexOf(': ') + 2));

    const registered = (listener: string) => `function f(g, apply) { const listen = EventTarget.prototype.addEventListener; apply(listen, g, ['error', ${listener}, true]); }`;

    it('a member read, `?.`, and a computed read', () => {
        expect(found(registered('(event) => { use(event.reason); }'))).toEqual(['a member read of the event: event.reason']);
        expect(found(registered('(event) => { use(event?.message); }'))).toEqual(['a member read of the event: event.message']);
        expect(found(registered('(event) => { use(event["reason"]); }'))).toEqual(['a computed read of the event: event[…]']);
    });

    it('a renamed parameter', () => {
        expect(found(registered('(anything) => { use(anything.reason); }'))).toEqual(['a member read of the event: anything.reason']);
        expect(found(registered('function (ev) { return ev.error; }'))).toEqual(['a member read of the event: ev.error']);
        expect(found(registered('x => x.message'))).toEqual(['a member read of the event: x.message']);
    });

    it('a destructured, a rest and a defaulted-by-pattern parameter', () => {
        expect(found(registered('({ reason }) => { use(reason); }'))).toEqual(['a destructured parameter where the event is']);
        expect(found(registered('([first]) => { use(first); }'))).toEqual(['a destructured parameter where the event is']);
        expect(found(registered('(...args) => { use(args); }'))).toEqual(['a rest parameter where the event is']);
    });

    it('the event destructured, spread or tested in the body', () => {
        expect(found(registered('(event) => { const { reason } = event; }'))).toEqual(['the event destructured']);
        expect(found(registered('(event) => { use({ ...event }); }'))).toEqual(['the event spread']);
        expect(found(registered('(event) => { use("reason" in event); }'))).toEqual(['the event iterated or tested with in']);
    });

    it('an alias, and a nested function that reads the event later', () => {
        expect(found(registered('(event) => { const copy = event; use(copy.reason); }'))).toEqual(['a member read of the event: copy.reason']);
        expect(found(registered('(event) => { queueMicrotask(() => use(event.reason)); }'))).toEqual(['a member read of the event: event.reason']);
    });

    it('an event put in a literal, where it is read later', () => {
        expect(found(registered('(event) => { const box = { held: event }; use(box.held.reason); }'))).toEqual(['the event put in a literal']);
        expect(found(registered('(event) => { const box = [event]; use(box); }'))).toEqual(['the event put in a literal']);
    });

    it('a helper the event is passed to, at any position, and through a second helper', () => {
        const helper = (listener: string) => `function f(g, apply) { const listen = EventTarget.prototype.addEventListener; const textOf = (label, e) => String(e.reason); const outer = (x) => textOf('a', x); apply(listen, g, ['error', ${listener}, true]); }`;
        expect(found(helper('(event) => outer(event)'))).toEqual(['a member read of the event: e.reason']);
        expect(found(helper('(event) => textOf("a", event)'))).toEqual(['a member read of the event: e.reason']);
    });

    it('a listener that is a named function, a variable, or what a local function returns', () => {
        const source = (registration: string) => `function f(g, apply) { const listen = EventTarget.prototype.addEventListener; function named(e) { return e.reason; } const arrow = (e) => e.message; const make = (kind) => { if (kind === 1) return (e) => e.error; return named; }; const made = make(1); ${registration} }`;
        expect(found(source("apply(listen, g, ['x', named, true]);"))).toEqual(['a member read of the event: e.reason']);
        expect(found(source("apply(listen, g, ['x', arrow, true]);"))).toEqual(['a member read of the event: e.message']);
        expect(found(source("apply(listen, g, ['x', made, true]);")).sort()).toEqual(['a member read of the event: e.error', 'a member read of the event: e.reason']);
    });

    it('a direct addEventListener call, and an on… assignment', () => {
        expect(found('function f(port) { port.addEventListener("message", (m) => use(m.data)); }')).toEqual(['a member read of the event: m.data']);
        expect(found('function f(port) { port.onmessage = (m) => use(m.data); }')).toEqual(['a member read of the event: m.data']);
        expect(found('function f(port) { port.onmessage = function (m) { return m.ports; }; }')).toEqual(['a member read of the event: m.ports']);
    });

    it('a registration the scan cannot follow, and an addEventListener it does not understand, are errors', () => {
        expect(found('function f(g, handlerFromOutside) { const listen = EventTarget.prototype.addEventListener; apply(listen, g, ["x", handlerFromOutside, true]); }')).toEqual(['a registration whose listener the scan cannot follow']);
        expect(found('function f(g) { const take = g.addEventListener; use(g.addEventListener); }')).toEqual(['addEventListener used other than as a captured value or a call']);
        expect(found('function f(g) { const setter = getOwn(P, "onmessage").set; const other = getOwn(Q, "onerror"); use("onload"); }')).toEqual(['the name "onload" used outside a captured setter']);
    });
});

describe('negative controls: what the library does is not a finding', () => {
    const found = (source: string) => eventReads(source).findings;
    const listener = (body: string) => `function f(g, apply) { const listen = EventTarget.prototype.addEventListener; const readEvent = (e, kind) => { const getter = getters[kind]; return apply(getter, e, []); }; const cancel = Event.prototype.preventDefault; apply(listen, g, ['error', (event) => { ${body} }, true]); }`;

    it('isTrusted, a captured getter or method applied to the event, and readEvent\'s snapshot', () => {
        expect(found(listener('if (event.isTrusted !== true) return; const read = readEvent(event, "error"); use(read.message, read.error); apply(cancel, event, []);'))).toEqual([]);
        expect(found(listener('if (!event?.isTrusted) return; use(apply(getProperty, undefined, [event, "reason"]));'))).toEqual([]);
    });

    it('a nested function that has a value of its own under the same name, and a property that merely shares the name', () => {
        expect(found(listener('use((event) => event.reason); use(row.event.reason, { event: 1 }.event);'))).toEqual([]);
    });

    it('typeof sink, and a captured setter used as the library does', () => {
        expect(found('function f(port, apply) { const setOnMessage = getOwn(MessagePort.prototype, "onmessage").set; const run = (data) => data.type; apply(setOnMessage, port, [(ev) => { const data = apply(dataOf, ev, []); run(data); }]); }')).toEqual([]);
        expect(found('function f(g, apply) { const add = g.addEventListener; if (typeof add === "function") apply(add, g, ["message", (e) => e.isTrusted, true]); }')).toEqual([]);
    });
});
