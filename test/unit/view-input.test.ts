import { describe, it, expect, afterEach } from 'vitest';
import fc from 'fast-check';
import { cssLoadBound, inSandboxView, inStrictWorker, isStyleProperty, sanitizeRender, VIEW_CONTINUOUS_EVENT_TYPES, VIEW_EVENT_LIMITS, VIEW_EVENT_TYPES, VIEW_INPUT_IN_FLIGHT, VIEW_SET_STYLE_LIMITS, VIEW_STYLE_PROPERTIES, VIEW_OPTIONS, viewBudget, viewInputOutbox, type ViewInputEntry, type ViewOptions } from '@src/lib/in-sandbox-view';
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
        new Function(`(${inSandboxView.toString()})(${inSandboxFiles.toString()}, ${sanitizeRender.toString()}, ${viewBudget.toString()}, ${cssLoadBound.toString()}, ${JSON.stringify(options)}, ${viewInputOutbox.toString()}, ${isStyleProperty.toString()});`)();
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

    it('options: a pointerdown in a pointerCapture element captures the pointer to it, and a drag or selection inside it is cancelled until the release; a detail carries the rects its marks ask for', async () => {
        const captures: [Element, number][] = [];
        (Element.prototype as any).setPointerCapture = function (this: Element, id: number) { captures.push([this, id]); };
        try {
            const { render, fire, events } = await startView();
            render.postMessage({ type: 'VIEW_LISTEN', types: ['pointerdown', 'pointermove'], marks: [['pointerdown', 'pad', 3], ['pointermove', 'inner', 2]] });
            await settle();
            fire('pointerdown', { pointerId: 9, buttons: 1 });
            await until(() => events().length === 1);
            expect(captures).toEqual([[document.getElementById('pad'), 9]]);
            expect(events()[0].details[0].rects).toEqual([['pad', 0, 0, 0, 0]]); // jsdom lays nothing out
            let prevented = 0;
            const inner = document.getElementById('inner')!;
            fire('dragstart', { target: inner, preventDefault: () => { prevented++; } });
            fire('selectstart', { target: inner.appendChild(document.createTextNode('t')), preventDefault: () => { prevented++; } });
            fire('dragstart', { target: document.body, preventDefault: () => { prevented++; } }); // outside it
            expect(prevented).toBe(2);
            fire('pointerup', { pointerId: 9 });
            fire('dragstart', { target: inner, preventDefault: () => { prevented++; } });
            expect(prevented).toBe(2); // released
            fire('pointermove', { pointerId: 9 });
            render.postMessage({ type: 'VIEW_EVENT_ACK' });
            await until(() => events().length === 2);
            expect(events()[1].details[0].rects).toEqual([['inner', 0, 0, 0, 0]]);
        } finally {
            delete (Element.prototype as any).setPointerCapture;
        }
    });

    it("sums a wheel's deltas per element and unit, the pointer where it last was (clamped); a scroll carries the scrolled element's position and extent", async () => {
        const { render, fire, events } = await startView();
        render.postMessage({ type: 'VIEW_LISTEN', types: ['wheel', 'scroll'] });
        await settle();
        fire('wheel', { deltaX: 1, deltaY: 40, deltaZ: 0, deltaMode: 0, clientX: 5, clientY: 5 });
        await until(() => events().length === 1);
        fire('wheel', { deltaX: 0, deltaY: 40, deltaZ: 0, deltaMode: 0, clientX: 6, clientY: 5 });
        fire('wheel', { deltaX: 2, deltaY: 60, deltaZ: 0, deltaMode: 0, clientX: -50, clientY: 5, shiftKey: true });
        fire('wheel', { deltaX: 0, deltaY: 3, deltaZ: 0, deltaMode: 1, clientX: 7, clientY: 5 });
        const pad = document.getElementById('pad')!;
        fire('scroll', { target: pad });
        fire('scroll', { target: pad });
        await settle();
        render.postMessage({ type: 'VIEW_EVENT_ACK' });
        await until(() => events().length === 2);
        const [pixel, line, scroll] = events()[1].details;
        expect(pixel).toMatchObject({ type: 'wheel', ids: ['inner', 'pad'], wheel: { dx: 2, dy: 100, dz: 0, unit: 'pixel' }, pointer: { x: 0, y: 5 }, coalesced: 2, modifiers: { shift: true } });
        expect(line).toMatchObject({ type: 'wheel', wheel: { dx: 0, dy: 3, dz: 0, unit: 'line' }, coalesced: 1 });
        expect(scroll).toEqual({ type: 'scroll', ids: ['pad'], target: { tag: 'div', id: 'pad', name: '', value: '', checked: false }, scroll: { top: 0, left: 0, width: 0, height: 0, clientWidth: 0, clientHeight: 0 }, time: 1235, coalesced: 2 });
    });
});

// The strict prelude against stand-ins for the worker's platform (as in view-api.test.ts).
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
function startPrelude() {
    const w = new FakeTarget() as any;
    w.URL = {};
    const reported: unknown[] = [];
    w.reportError = (error: unknown) => reported.push(error);
    const run = new Function('globalThis', 'EventTarget', 'MessageEvent', 'Event', 'MessagePort', `return (${inStrictWorker.toString()})`)(w, FakeTarget, FakeMessageEvent, FakeEvent, FakePort);
    run({ attach: () => {}, log: () => {} }, { scriptUnsafe: false, maxRender: 100, maxTarget: 50, maxElements: 100, maxDepth: 10, maxCharacters: 1000, entryDoneName: '__testEntryDone', eventTypes: VIEW_EVENT_TYPES, maxMarks: VIEW_EVENT_LIMITS.maxIds, style: { properties: VIEW_STYLE_PROPERTIES, ...VIEW_SET_STYLE_LIMITS } }, isStyleProperty);
    const render = new FakePort();
    w.listeners.message(new FakeMessageEvent({ data: { type: 'INIT_WORKER' }, ports: [new FakePort(), render] }));
    const sent = () => render.posted.filter(frame => frame.type !== 'VIEW_STARTED' && frame.type !== 'VIEW_LISTEN' && frame.type !== 'VIEW_EVENT_ACK');
    return { view: w.sandboxView, render, reported, sent };
}

describe('the prelude acknowledges each frame of events once its handlers have returned', () => {
    it('dispatches the details in order, a throwing handler reported, and posts one VIEW_EVENT_ACK after all of them', () => {
        const { view, render, reported } = startPrelude();
        const seen: string[] = [];
        view.on('pointermove', null, (d: any) => {
            seen.push('move ' + d.pointer.x);
            expect(render.posted.some(f => f.type === 'VIEW_EVENT_ACK')).toBe(false);
        });
        view.on('pointerup', 'pad', () => { seen.push('up'); throw new Error('broke'); });
        view.on('pointerup', null, () => seen.push('up, any'));
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

describe('sandboxView.set({ scroll })', () => {
    it('takes { top?, left? } of finite numbers, read once; anything else is a TypeError and nothing is sent', () => {
        const { view, sent } = startPrelude();
        for (const scroll of [null, 5, 'top', [1], { top: '5' }, { top: NaN }, { left: Infinity }, { bottom: 1 }]) {
            expect(() => view.set('list', { scroll }), JSON.stringify(scroll)).toThrow(TypeError);
        }
        expect(sent()).toEqual([]);
        let reads = 0;
        view.set('list', { scroll: { get top() { reads++; return 120; }, left: 0 } });
        expect(reads).toBe(1);
        expect(sent()).toEqual([{ type: 'VIEW_SET', id: 'list', scroll: { top: 120, left: 0 } }]);
    });

    it('consecutive sets of one id merge their scroll key by key, the later winning', () => {
        const { view, sent, render } = startPrelude();
        view.set('a', { value: 'x' }); // in flight
        view.set('list', { scroll: { top: 1 } });
        view.set('list', { scroll: { left: 2 } });
        view.set('list', { scroll: { top: 3 } });
        render.deliver({ type: 'VIEW_ACK' });
        expect(sent()).toEqual([{ type: 'VIEW_SET', id: 'a', value: 'x' }, { type: 'VIEW_SET', id: 'list', scroll: { top: 3, left: 2 } }]);
    });
});

describe('set({ css }): the closed list of style properties and its limits', () => {
    const codeAt = (text: string, at: number) => text.charCodeAt(at);
    const allowed = (name: string) => isStyleProperty(name, VIEW_STYLE_PROPERTIES, VIEW_SET_STYLE_LIMITS.maxValue, codeAt);

    it('VIEW_STYLE_PROPERTIES and custom properties only: no animation, transition, background or any other property; `--*` stands for custom properties', () => {
        for (const name of VIEW_STYLE_PROPERTIES.filter(p => p !== '--*')) expect(allowed(name), name).toBe(true);
        for (const name of ['--x', '--drag-x', '--A_1']) expect(allowed(name), name).toBe(true);
        for (const name of ['--*', '--', '-x', '--a b', '--a;b', '--é', 'animation', 'animation-name', 'transition', 'background', 'background-image',
            'content', 'position', 'display', 'filter', 'mask', 'Transform', 'transform ', '-webkit-transform', '--' + 'x'.repeat(VIEW_SET_STYLE_LIMITS.maxValue)]) {
            expect(allowed(name), name).toBe(false);
        }
        expect(VIEW_STYLE_PROPERTIES.some(p => /animation|transition/.test(p))).toBe(false);
        expect(VIEW_SET_STYLE_LIMITS).toEqual({ maxProperties: 16, maxValue: 1024 });
    });

    it('the prelude: each name on the list, each value a string or null, read once; past maxProperties or maxValue a RangeError; nothing refused is sent', () => {
        const { view, sent } = startPrelude();
        expect(() => view.set('t', { css: { 'background-image': 'url(x)' } })).toThrow(TypeError);
        expect(() => view.set('t', { css: { animation: 'spin 1s' } })).toThrow(TypeError);
        expect(() => view.set('t', { css: { transform: 5 } })).toThrow(TypeError);
        expect(() => view.set('t', { css: 'transform: none' })).toThrow(TypeError);
        expect(() => view.set('t', { css: { transform: 'x'.repeat(VIEW_SET_STYLE_LIMITS.maxValue + 1) } })).toThrow(RangeError);
        const many: Record<string, string> = {};
        for (let i = 0; i <= VIEW_SET_STYLE_LIMITS.maxProperties; i++) many['--p' + i] = '1';
        expect(() => view.set('t', { css: many })).toThrow(RangeError);
        expect(sent()).toEqual([]);
        let reads = 0;
        view.set('t', { css: { get transform() { reads++; return 'translate(1px, 2px)'; }, opacity: null, '--x': '3' } });
        expect(reads).toBe(1);
        expect(sent()).toEqual([{ type: 'VIEW_SET', id: 't', css: { transform: 'translate(1px, 2px)', opacity: null, '--x': '3' } }]);
    });

    it('consecutive sets of one id merge their css key by key, unless together they would name more than maxProperties', () => {
        const { view, sent, render } = startPrelude();
        view.set('a', { value: 'x' }); // in flight
        view.set('t', { css: { left: '1px' } });
        view.set('t', { css: { top: '2px', left: '3px' } });
        const many: Record<string, string> = {};
        for (let i = 0; i < VIEW_SET_STYLE_LIMITS.maxProperties; i++) many['--p' + i] = '1';
        view.set('t', { css: many }); // 16 more: not merged
        for (let i = 0; i < 3; i++) render.deliver({ type: 'VIEW_ACK' });
        expect(sent().map(f => f.css)).toEqual([undefined, { left: '3px', top: '2px' }, many]);
    });
});

describe("sandboxView.on's options: pointerCapture, rect and preventDefault", () => {
    it('are read once and checked: pointerCapture for a pointerdown with an id, rect with an id, preventDefault for a wheel; unknown ones are a TypeError', () => {
        const { view } = startPrelude();
        const h = () => {};
        expect(() => view.on('pointerdown', 'thumb', h, { pointerCapture: true })).not.toThrow();
        expect(() => view.on('pointermove', 'thumb', h, { pointerCapture: true })).toThrow(TypeError);
        expect(() => view.on('pointerdown', null, h, { pointerCapture: true })).toThrow(TypeError);
        expect(() => view.on('click', null, h, { rect: true })).toThrow(TypeError);
        expect(() => view.on('click', 'x', h, { rect: true })).not.toThrow();
        expect(() => view.on('pointerdown', 'x', h, { preventDefault: true })).toThrow(TypeError);
        expect(() => view.on('wheel', null, h, { preventDefault: true })).not.toThrow();
        expect(() => view.on('wheel', null, h, { passive: false })).toThrow(TypeError);
        expect(() => view.on('wheel', null, h, { rect: 'yes' })).toThrow(TypeError);
        expect(() => view.on('wheel', null, h, 'rect')).toThrow(TypeError);
        expect(() => view.on('wheel', null, h, { rect: false, preventDefault: undefined })).not.toThrow();
        let reads = 0;
        view.on('pointerdown', 'pad', h, { get rect() { reads++; return true; } });
        expect(reads).toBe(1);
    });

    it('reach the view as marks, one per element and type with the options of its handlers together, and go when the last handler does', () => {
        const { view, render } = startPrelude();
        const listens = () => render.posted.filter(f => f.type === 'VIEW_LISTEN');
        const off1 = view.on('pointerdown', 'thumb', () => {}, { pointerCapture: true });
        const off2 = view.on('pointerdown', 'thumb', () => {}, { rect: true });
        view.on('wheel', null, () => {}, { preventDefault: true });
        view.on('pointermove', 'thumb', () => {});
        expect(listens().at(-1)).toEqual({ type: 'VIEW_LISTEN', types: ['pointerdown', 'pointermove', 'wheel'], marks: [['pointerdown', 'thumb', 3], ['wheel', null, 4]] });
        off1();
        expect(listens().at(-1).marks).toEqual([['pointerdown', 'thumb', 2], ['wheel', null, 4]]);
        off2();
        expect(listens().at(-1)).toEqual({ type: 'VIEW_LISTEN', types: ['pointermove', 'wheel'], marks: [['wheel', null, 4]] });
    });

    it(`at most VIEW_EVENT_LIMITS.maxIds (${VIEW_EVENT_LIMITS.maxIds}) elements a type with options; past it a RangeError`, () => {
        const { view } = startPrelude();
        for (let i = 0; i < VIEW_EVENT_LIMITS.maxIds; i++) view.on('click', 'e' + i, () => {}, { rect: true });
        view.on('click', 'e0', () => {}, { rect: true }); // an element already marked
        view.on('click', 'other', () => {}); // no options
        expect(() => view.on('click', 'one-more', () => {}, { rect: true })).toThrow(RangeError);
        expect(() => view.on('pointerdown', 'one-more', () => {}, { rect: true })).not.toThrow(); // another type
    });

    it("rect: each handler that asked gets its own element's rectangle as `rect`, in a copy; the others get the detail without it", () => {
        const { view, render } = startPrelude();
        const seen: any[] = [];
        view.on('pointerdown', 'thumb', (d: any) => seen.push(['thumb', d]), { rect: true });
        view.on('pointerdown', 'pad', (d: any) => seen.push(['pad', d]), { rect: true });
        view.on('pointerdown', null, (d: any) => seen.push(['any', d]));
        render.deliver({ type: 'VIEW_EVENT', details: [{ type: 'pointerdown', ids: ['thumb', 'pad'], pointer: { x: 1 }, rects: [['thumb', 20, 20, 40, 40], ['pad', 0, 0, 400, 300]] }] });
        expect(seen.map(([who, d]) => [who, d.rect])).toEqual([['thumb', { x: 20, y: 20, width: 40, height: 40 }], ['pad', { x: 0, y: 0, width: 400, height: 300 }], ['any', undefined]]);
        for (const [, d] of seen) expect('rects' in d).toBe(false);
        expect(seen[0][1].pointer).toEqual({ x: 1 });
    });
});

describe('the view applies set({ css }) and the options (inSandboxView, run as stringified)', () => {
    const originalWorker = (globalThis as any).Worker;
    const originalAdd = window.addEventListener;
    afterEach(() => {
        (globalThis as any).Worker = originalWorker;
        window.addEventListener = originalAdd;
        delete (globalThis as any).__sandboxViewRuns;
        document.body.replaceChildren();
    });
    async function start(options: ViewOptions = VIEW_OPTIONS) {
        const registered: [string, unknown][] = [];
        window.addEventListener = function (this: Window, type: string, listener: any, how?: any) {
            registered.push([type, how]);
            return originalAdd.call(this, type, listener, how);
        } as typeof window.addEventListener;
        const workers: { transfer: MessagePort[] }[] = [];
        (globalThis as any).Worker = class {
            onerror: unknown = null;
            constructor() { workers.push({ transfer: [] }); }
            postMessage(_message: unknown, transfer: MessagePort[]) { workers[workers.length - 1]!.transfer = transfer; }
        };
        new Function(`(${inSandboxView.toString()})(${inSandboxFiles.toString()}, ${sanitizeRender.toString()}, ${viewBudget.toString()}, ${cssLoadBound.toString()}, ${JSON.stringify(options)}, ${viewInputOutbox.toString()}, ${isStyleProperty.toString()});`)();
        const a = new MessageChannel(), b = new MessageChannel();
        window.dispatchEvent(new MessageEvent('message', { data: { type: 'INIT_VIEW', workerSource: 'void 0', viewFiles: [], html: '<div id="t" style="color: red"></div><svg><rect id="r"></rect></svg>' }, source: window, ports: [a.port1, b.port1] }));
        const render = workers[0]!.transfer[1]!;
        const received: any[] = [];
        render.onmessage = (event) => received.push(event.data);
        render.postMessage({ type: 'VIEW_STARTED' });
        const acks = () => received.filter(m => m.type === 'VIEW_ACK');
        const send = async (message: unknown) => {
            const before = acks().length;
            render.postMessage(message);
            for (let i = 0; i < 300 && acks().length === before; i++) await new Promise(resolve => setTimeout(resolve, 5));
            return acks()[acks().length - 1];
        };
        return { render, received, send, registered };
    }

    it('sets and removes inline properties of an HTML or SVG element; a property off the list, a value too long or too many properties is refused whole', async () => {
        const { send } = await start();
        const t = () => document.getElementById('t')!.getAttribute('style');
        expect(await send({ type: 'VIEW_SET', id: 't', css: { transform: 'translate(5px, 6px)', opacity: '0.5', '--drag': '1' } })).toEqual({ type: 'VIEW_ACK' });
        expect(t()).toBe('color: red; transform: translate(5px, 6px); opacity: 0.5; --drag: 1;');
        await send({ type: 'VIEW_SET', id: 't', css: { opacity: null } });
        expect(t()).toBe('color: red; transform: translate(5px, 6px); --drag: 1;');
        await send({ type: 'VIEW_SET', id: 'r', css: { transform: 'scale(2)' } });
        expect(document.getElementById('r')!.getAttribute('style')).toBe('transform: scale(2);');
        for (const css of [{ 'background-image': 'url(x)' }, { animation: 'x 1s' }, { left: 'x'.repeat(VIEW_SET_STYLE_LIMITS.maxValue + 1) }, Object.fromEntries(Array.from({ length: 17 }, (_, i) => ['--p' + i, '1'])), { left: 5 }, ['left']]) {
            await send({ type: 'VIEW_SET', id: 't', css });
        }
        expect(t()).toBe('color: red; transform: translate(5px, 6px); --drag: 1;');
    });

    it("what the style attribute grows by counts against the view's characters: past VIEW_MAX_CHARACTERS the set is refused by name and the element left as it was", async () => {
        const { send } = await start({ ...VIEW_OPTIONS, render: { ...VIEW_OPTIONS.render, maxCharacters: 400 } });
        const before = document.getElementById('t')!.getAttribute('style');
        expect(await send({ type: 'VIEW_SET', id: 't', css: { '--a': 'x'.repeat(200), '--b': 'y'.repeat(200) } })).toEqual({ type: 'VIEW_ACK', refused: ['VIEW_MAX_CHARACTERS'] });
        expect(document.getElementById('t')!.getAttribute('style')).toBe(before);
        expect(await send({ type: 'VIEW_SET', id: 't', css: { '--a': 'x'.repeat(100) } })).toEqual({ type: 'VIEW_ACK' });
    });

    it('a wheel listener that is not passive is added only while a preventDefault mark exists; marks of other types, or with an overlong id, are dropped', async () => {
        const { render, registered } = await start();
        const wheelListeners = () => registered.filter(([type, how]) => type === 'wheel' && (how as any)?.passive === false).length;
        const pause = () => new Promise(resolve => setTimeout(resolve, 20));
        render.postMessage({ type: 'VIEW_LISTEN', types: ['wheel'], marks: [['wheel', 'x'.repeat(2000), 4], ['nope', 't', 4]] });
        await pause();
        expect(wheelListeners()).toBe(0);
        render.postMessage({ type: 'VIEW_LISTEN', types: ['wheel'], marks: [['wheel', null, 4]] });
        render.postMessage({ type: 'VIEW_LISTEN', types: ['wheel'], marks: [['wheel', 't', 4]] });
        await pause();
        expect(wheelListeners()).toBe(1); // still the one
        render.postMessage({ type: 'VIEW_LISTEN', types: ['wheel'], marks: [] });
        render.postMessage({ type: 'VIEW_LISTEN', types: ['wheel'], marks: [['wheel', 't', 4]] });
        await pause();
        expect(wheelListeners()).toBe(2); // removed with the last mark, added again with the next
    });
});
