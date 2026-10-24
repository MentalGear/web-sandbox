import { describe, it, expect, afterEach } from 'vitest';
import fc from 'fast-check';
import { cssLoadBound, inSandboxView, inStrictWorker, sanitizeRender, VIEW_CONTINUOUS_EVENT_TYPES, VIEW_EVENT_TYPES, VIEW_INPUT_IN_FLIGHT, VIEW_OPTIONS, viewBudget, viewInputOutbox, type ViewInputEntry, type ViewOptions } from '@src/lib/in-sandbox-view';
import { inSandboxFiles } from '@src/lib/in-sandbox-files';

/**
 * Strict mode's pointer, wheel, scroll and focus input (research 23): the view's input outbox as arithmetic (coalescing,
 * the in-flight rule, clamping), the view's event path run as stringified against events handed to its listeners (jsdom
 * makes no trusted pointer event of its own), and the worker's prelude, which acknowledges each frame once its handlers
 * have returned. The engines' side is test/e2e/strict-pointer-events.spec.ts.
 */

const entry = (type: string, key: unknown, extra: Partial<ViewInputEntry> = {}): ViewInputEntry => ({ type, key, unit: '', coalesced: 1, ...extra });

describe('the input outbox (viewInputOutbox)', () => {
    it('coalesces per type and key: the latest wins and moves to the end, `coalesced` counts the raw events', () => {
        const outbox = viewInputOutbox(1);
        outbox.put(entry('pointermove', 1, { x: 1 }));
        outbox.put(entry('pointermove', 2, { x: 10 }));
        outbox.put(entry('pointermove', 1, { x: 2 }));
        outbox.put(entry('pointermove', 1, { x: 3 }));
        expect(outbox.pending()).toBe(2);
        expect(outbox.take()).toEqual([entry('pointermove', 2, { x: 10 }), entry('pointermove', 1, { x: 3, coalesced: 3 })]);
        expect(outbox.pending()).toBe(0);
    });

    it('sums the deltas of a wheel per element and unit; another unit is another slot', () => {
        const outbox = viewInputOutbox(1);
        const element = {};
        outbox.put(entry('wheel', element, { unit: 'pixel', wheel: { dx: 1, dy: 10, dz: 0, unit: 'pixel' } }));
        outbox.put(entry('wheel', element, { unit: 'pixel', wheel: { dx: 2, dy: 20, dz: 1, unit: 'pixel' } }));
        outbox.put(entry('wheel', element, { unit: 'line', wheel: { dx: 0, dy: 3, dz: 0, unit: 'line' } }));
        outbox.put(entry('wheel', {}, { unit: 'pixel', wheel: { dx: 5, dy: 5, dz: 5, unit: 'pixel' } }));
        const [first, second, third] = outbox.take();
        expect(first!.wheel).toEqual({ dx: 3, dy: 30, dz: 1, unit: 'pixel' });
        expect(first!.coalesced).toBe(2);
        expect(second!.wheel).toEqual({ dx: 0, dy: 3, dz: 0, unit: 'line' });
        expect(third!.wheel).toEqual({ dx: 5, dy: 5, dz: 5, unit: 'pixel' });
    });

    it(`the in-flight rule: ready only while fewer than ${VIEW_INPUT_IN_FLIGHT} frame is unacknowledged and something is pending; every frame taken counts until it is acknowledged`, () => {
        expect(VIEW_INPUT_IN_FLIGHT).toBe(1);
        const outbox = viewInputOutbox(VIEW_INPUT_IN_FLIGHT);
        expect(outbox.ready()).toBe(false); // nothing pending
        outbox.put(entry('pointermove', 1));
        expect(outbox.ready()).toBe(true);
        outbox.take();
        outbox.put(entry('pointermove', 1));
        expect(outbox.ready()).toBe(false); // one in flight
        expect(outbox.unacknowledged()).toBe(1);
        outbox.take(); // a discrete event's frame goes whatever is in flight, and counts too
        expect(outbox.unacknowledged()).toBe(2);
        outbox.put(entry('pointermove', 1));
        outbox.acked();
        expect(outbox.ready()).toBe(false);
        outbox.acked();
        expect(outbox.ready()).toBe(true);
        outbox.acked(); // an extra acknowledgement never makes room for more than the limit
        expect(outbox.unacknowledged()).toBe(0);
        outbox.take();
        expect(outbox.unacknowledged()).toBe(1);
    });

    it('clamps a coordinate to [0, most] and rounds it to 0.1', () => {
        const { clamp } = viewInputOutbox(1);
        expect([clamp(-5, 300), clamp(0, 300), clamp(12.345, 300), clamp(299.96, 300), clamp(1e9, 300), clamp(-0.04, 300)]).toEqual([0, 0, 12.3, 300, 300, 0]);
    });

    it('property: whatever the events and acknowledgements, a continuous frame goes only with nothing unacknowledged, holds each key once, and no raw event is lost from the count', () => {
        const step = fc.oneof(
            fc.record({ kind: fc.constant('move' as const), key: fc.integer({ min: 0, max: 3 }) }),
            fc.record({ kind: fc.constant('discrete' as const) }),
            fc.record({ kind: fc.constant('frame' as const) }),
            fc.record({ kind: fc.constant('ack' as const) }),
        );
        fc.assert(fc.property(fc.array(step, { maxLength: 200 }), (steps) => {
            const outbox = viewInputOutbox(VIEW_INPUT_IN_FLIGHT);
            let put = 0, sent = 0, inFlight = 0;
            for (const s of steps) {
                if (s.kind === 'move') {
                    outbox.put(entry('pointermove', s.key));
                    put++;
                } else if (s.kind === 'frame') {
                    if (!outbox.ready()) continue;
                    expect(inFlight).toBe(0);
                    const batch = outbox.take();
                    inFlight++;
                    expect(new Set(batch.map(e => e.key)).size).toBe(batch.length);
                    sent += batch.reduce((n, e) => n + e.coalesced, 0);
                } else if (s.kind === 'discrete') {
                    sent += outbox.take().reduce((n, e) => n + e.coalesced, 0);
                    inFlight++;
                } else if (inFlight > 0) {
                    outbox.acked();
                    inFlight--;
                }
                expect(outbox.unacknowledged()).toBe(inFlight);
            }
            const left = outbox.take().reduce((n, e) => n + e.coalesced, 0);
            expect(sent + left).toBe(put);
        }));
    });
});

// The view's bootstrap in this document, its listeners captured by type and called with events made to look trusted;
// the worker's end of the render port records what the view posts.
describe("the view's event path (inSandboxView, run as stringified)", () => {
    const originalWorker = (globalThis as any).Worker;
    const originalAdd = window.addEventListener;
    afterEach(() => {
        (globalThis as any).Worker = originalWorker;
        window.addEventListener = originalAdd;
        delete (globalThis as any).__sandboxViewRuns;
        document.body.replaceChildren();
    });

    async function startView(options: ViewOptions = VIEW_OPTIONS) {
        const listeners: Record<string, ((event: unknown) => void)[]> = {};
        const registered: Record<string, unknown[]> = {};
        window.addEventListener = function (this: Window, type: string, listener: any, how?: any) {
            (listeners[type] ??= []).push(listener);
            (registered[type] ??= []).push(how);
            return originalAdd.call(this, type, listener, how);
        } as typeof window.addEventListener;
        const workers: { transfer: MessagePort[] }[] = [];
        (globalThis as any).Worker = class {
            onerror: unknown = null;
            constructor() { workers.push({ transfer: [] }); }
            postMessage(_message: unknown, transfer: MessagePort[]) { workers[workers.length - 1]!.transfer = transfer; }
        };
        new Function(`(${inSandboxView.toString()})(${inSandboxFiles.toString()}, ${sanitizeRender.toString()}, ${viewBudget.toString()}, ${cssLoadBound.toString()}, ${JSON.stringify(options)}, ${viewInputOutbox.toString()});`)();
        const a = new MessageChannel(), b = new MessageChannel();
        window.dispatchEvent(new MessageEvent('message', { data: { type: 'INIT_VIEW', workerSource: 'void 0', viewFiles: [], html: '<div id="pad" style="width:100px;height:100px"><span id="inner"></span></div>' }, source: window, ports: [a.port1, b.port1] }));
        const render = workers[0]!.transfer[1]!;
        const received: any[] = [];
        render.onmessage = (event) => received.push(event.data);
        render.postMessage({ type: 'VIEW_STARTED' });
        const fire = (type: string, init: Record<string, unknown>) => {
            const event = { isTrusted: true, type, target: document.getElementById('inner'), timeStamp: 1234.56, pointerId: 1, pointerType: 'mouse', isPrimary: true, button: -1, buttons: 0, clientX: 10, clientY: 20, pressure: 0, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, ...init };
            for (const listener of listeners[type] ?? []) listener(event);
        };
        const events = () => received.filter(m => m.type === 'VIEW_EVENT');
        return { render, received, fire, events, registered };
    }
    const until = async (check: () => boolean) => {
        for (let i = 0; i < 300 && !check(); i++) await new Promise(resolve => setTimeout(resolve, 5));
        expect(check()).toBe(true);
    };
    const settle = () => new Promise(resolve => setTimeout(resolve, 150)); // past a frame and the flush's fallback timer

    it('listens on every type of VIEW_EVENT_TYPES, the pointer types passively; continuous types are a subset', async () => {
        const { registered } = await startView();
        for (const type of VIEW_EVENT_TYPES) expect(registered[type], type).toBeDefined();
        for (const type of VIEW_EVENT_TYPES.filter(t => t.startsWith('pointer'))) expect(registered[type]).toContainEqual({ capture: true, passive: true });
        for (const type of VIEW_CONTINUOUS_EVENT_TYPES) expect(VIEW_EVENT_TYPES as readonly string[]).toContain(type);
    });

    it('forwards nothing unsubscribed and nothing untrusted; a pointerdown is posted at once with its detail: pointer, modifiers, time, numbers only', async () => {
        const { render, fire, events } = await startView();
        fire('pointerdown', {});
        render.postMessage({ type: 'VIEW_LISTEN', types: ['pointerdown', 'pointermove'] });
        await settle();
        fire('pointerdown', { isTrusted: false });
        await settle();
        expect(events()).toEqual([]);
        fire('pointerdown', { button: 0, buttons: 1, clientX: 12.345, clientY: 7.06, pressure: 0.5049, shiftKey: true, pointerType: 'pen', isPrimary: false, pointerId: 7 });
        await until(() => events().length === 1);
        expect(events()[0]).toEqual({ type: 'VIEW_EVENT', details: [{
            type: 'pointerdown', ids: ['inner', 'pad'], target: { tag: 'span', id: 'inner', name: '', value: '', checked: false },
            pointer: { x: 12.3, y: 7.1, id: 7, kind: 'pen', primary: false, button: 0, buttons: 1, pressure: 0.5 },
            modifiers: { alt: false, ctrl: false, meta: false, shift: true }, time: 1235,
        }] });
    });

    it('coalesces moves per pointer, one frame at a time: nothing more until VIEW_EVENT_ACK, then only the latest; a pointerup goes at once, behind the moves before it', async () => {
        const { render, fire, events } = await startView();
        render.postMessage({ type: 'VIEW_LISTEN', types: ['pointermove', 'pointerup'] });
        await settle();
        for (let i = 1; i <= 5; i++) fire('pointermove', { clientX: i });
        await until(() => events().length === 1);
        expect(events()[0].details).toHaveLength(1);
        expect(events()[0].details[0]).toMatchObject({ type: 'pointermove', coalesced: 5, pointer: { x: 5 } });
        for (let i = 6; i <= 9; i++) fire('pointermove', { clientX: i });
        fire('pointermove', { clientX: 50, pointerId: 2 });
        await settle();
        expect(events()).toHaveLength(1); // the first frame is not acknowledged
        render.postMessage({ type: 'VIEW_EVENT_ACK' });
        await until(() => events().length === 2);
        expect(events()[1].details.map((d: any) => [d.pointer.id, d.pointer.x, d.coalesced])).toEqual([[1, 9, 4], [2, 50, 1]]);
        fire('pointermove', { clientX: 60 });
        fire('pointerup', { clientX: 61 });
        await until(() => events().length === 3); // unacknowledged, but a discrete event goes at once, the move before it first
        expect(events()[2].details.map((d: any) => [d.type, d.pointer.x])).toEqual([['pointermove', 60], ['pointerup', 61]]);
        await settle();
        expect(events()).toHaveLength(3);
    });

    it('clamps coordinates to the view; a move outside it is forwarded only while a press that began in the view is held', async () => {
        const { render, fire, events } = await startView();
        render.postMessage({ type: 'VIEW_LISTEN', types: ['pointermove'] });
        await settle();
        const send = async (init: Record<string, unknown>) => {
            const before = events().length;
            fire('pointermove', init);
            await settle();
            const after = events().slice(before);
            if (after.length > 0) render.postMessage({ type: 'VIEW_EVENT_ACK' });
            return after.flatMap(e => e.details.map((d: any) => [d.pointer.x, d.pointer.y]));
        };
        const [w, h] = [window.innerWidth, window.innerHeight];
        expect(await send({ clientX: w + 300, clientY: 10, buttons: 0 })).toEqual([]); // no press: the host page's
        fire('pointerdown', { buttons: 1 }); // a press in the view (pointerdown not subscribed: tracked all the same)
        expect(await send({ clientX: w + 300, clientY: -40, buttons: 1 })).toEqual([[w, 0]]);
        expect(await send({ clientX: -5, clientY: h + 1, buttons: 0 })).toEqual([]); // released outside the window
        fire('pointerup', {});
        expect(await send({ clientX: w + 1, clientY: 5, buttons: 1 })).toEqual([]);
        expect(await send({ clientX: 3, clientY: 4 })).toEqual([[3, 4]]);
    });
});

// The strict prelude against stand-ins for the worker's platform (as in view-api.test.ts).
describe('the prelude acknowledges each frame of events once its handlers have returned', () => {
    class FakeEvent { stopImmediatePropagation() {} preventDefault() {} }
    class FakeMessageEvent extends FakeEvent {
        readonly isTrusted = true;
        constructor(private readonly init: { data?: unknown; ports?: unknown[] }) { super(); }
        get data() { return this.init.data; }
        get ports() { return this.init.ports ?? []; }
    }
    class FakeTarget {
        listeners: Record<string, (event: unknown) => void> = {};
        addEventListener(type: string, listener: (event: unknown) => void) { this.listeners[type] = listener; }
    }
    class FakePort extends FakeTarget {
        posted: any[] = [];
        postMessage(frame: unknown) { this.posted.push(structuredClone(frame)); }
        start() {}
        deliver(data: unknown) { this.listeners.message!(new FakeMessageEvent({ data })); }
    }

    it('dispatches the details in order, a throwing handler reported, and posts one VIEW_EVENT_ACK after all of them', () => {
        const w = new FakeTarget() as any;
        w.URL = {};
        const reported: unknown[] = [];
        w.reportError = (error: unknown) => reported.push(error);
        const run = new Function('globalThis', 'EventTarget', 'MessageEvent', 'Event', 'MessagePort', `return (${inStrictWorker.toString()})`)(w, FakeTarget, FakeMessageEvent, FakeEvent, FakePort);
        run({ attach: () => {}, log: () => {} }, { scriptUnsafe: false, maxRender: 100, maxTarget: 50, maxElements: 100, maxDepth: 10, maxCharacters: 1000, entryDoneName: '__testEntryDone', eventTypes: VIEW_EVENT_TYPES });
        const render = new FakePort();
        w.listeners.message(new FakeMessageEvent({ data: { type: 'INIT_WORKER' }, ports: [new FakePort(), render] }));
        const seen: string[] = [];
        w.sandboxView.on('pointermove', null, (d: any) => {
            seen.push('move ' + d.pointer.x);
            expect(render.posted.some(f => f.type === 'VIEW_EVENT_ACK')).toBe(false);
        });
        w.sandboxView.on('pointerup', 'pad', () => { seen.push('up'); throw new Error('broke'); });
        w.sandboxView.on('pointerup', null, () => seen.push('up, any'));
        render.deliver({ type: 'VIEW_EVENT', details: [
            { type: 'pointermove', ids: ['pad'], pointer: { x: 1 } },
            { type: 'pointerup', ids: ['pad'], pointer: { x: 2 } },
        ] });
        expect(seen).toEqual(['move 1', 'up', 'up, any']);
        expect(reported).toHaveLength(1);
        expect(render.posted.filter(f => f.type === 'VIEW_EVENT_ACK')).toEqual([{ type: 'VIEW_EVENT_ACK' }]);
        render.deliver({ type: 'VIEW_EVENT', details: 'not a list' });
        expect(render.posted.filter(f => f.type === 'VIEW_EVENT_ACK')).toHaveLength(2); // acknowledged all the same: never a stall
    });
});
