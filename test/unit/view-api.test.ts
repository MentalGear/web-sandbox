import { describe, it, expect, vi, afterEach } from 'vitest';

/**
 * R4-5, the owner's decision after review round 1 (docs/security/REVIEW-ROUND-1-2026-10-15.md, "Awaiting the owner"):
 * three public names. viewScriptHash() for an embedder's own Content-Security-Policy, and sandboxView.text() and
 * sandboxView.set(), so a strict guest updates text and form controls without hand-escaping markup or re-rendering. The
 * browsers' side is test/e2e/owner-decisions.spec.ts ("R4-5"), on all three engines.
 */

const parse = (html: string) => new DOMParser().parseFromString(html, 'text/html');
const wrapperOf = (el: HTMLElement) => el.shadowRoot!.querySelector('iframe')!;

async function mount(config: Record<string, unknown>) {
    const { defineWebSandbox } = await import('@src/host');
    defineWebSandbox();
    const el = document.createElement('web-sandbox') as any;
    document.body.appendChild(el);
    el.setConfig(config);
    return el;
}

afterEach(() => {
    vi.restoreAllMocks();
    document.body.replaceChildren();
});

describe('R4-5: viewScriptHash(), the view bootstrap\'s hash source for an embedder\'s own policy', () => {
    it('is exported, and is the hash the host puts in the view\'s script-src: one implementation, the SHA-256 of the bootstrap text as served', async () => {
        const { webcrypto } = await import('node:crypto');
        const api = await import('@src/index');
        const { viewBootstrapText } = await import('@src/lib/in-sandbox-view');
        expect(typeof api.viewScriptHash).toBe('function');
        const hash = api.viewScriptHash();
        const digest = new Uint8Array(await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(viewBootstrapText())));
        expect(hash).toBe(`'sha256-${Buffer.from(digest).toString('base64')}'`);
        const el = await mount({ mode: 'strict' });
        const view = parse(parse(wrapperOf(el).srcdoc).querySelector('iframe')!.getAttribute('srcdoc')!);
        expect(view.querySelector('meta[http-equiv="Content-Security-Policy"]')!.getAttribute('content')).toContain(`script-src ${hash};`);
        expect(api.viewScriptHash()).toBe(hash); // constant for the page
    });
});

// The strict worker's prelude, run as stringified against stand-ins for the worker's platform (as in
// review-round-1.test.ts): a trusted INIT_WORKER hands it a render port whose posts are recorded, and the view's acks
// are delivered by hand. One message is in flight at a time (A4).
class FakeEvent {
    stopImmediatePropagation() {}
    preventDefault() {}
    get defaultPrevented() { return false; }
}
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

async function startPrelude(maxRender = 20) {
    const { inStrictWorker } = await import('@src/lib/in-sandbox-view');
    const w = new FakeTarget() as any;
    w.URL = {};
    const lines: string[] = [];
    const run = new Function('globalThis', 'EventTarget', 'MessageEvent', 'Event', 'MessagePort', `return (${inStrictWorker.toString()})`)(w, FakeTarget, FakeMessageEvent, FakeEvent, FakePort);
    run({ attach: () => {}, log: (_level: string, args: unknown[]) => lines.push(String(args[0])) }, { scriptUnsafe: false, maxRender, maxTarget: 5, maxElements: 100, maxDepth: 10, maxCharacters: 1000, entryDoneName: '__testEntryDone', eventTypes: ['click'] });
    const render = new FakePort();
    w.listeners.message(new FakeMessageEvent({ data: { type: 'INIT_WORKER' }, ports: [new FakePort(), render] }));
    const sent = () => render.posted.filter(frame => frame.type !== 'VIEW_STARTED' && frame.type !== 'VIEW_LISTEN');
    const ack = (refused?: string[]) => render.deliver(refused ? { type: 'VIEW_ACK', refused } : { type: 'VIEW_ACK' });
    return { view: w.sandboxView, sent, ack, lines };
}

describe('R4-5: sandboxView.text() and sandboxView.set() in the worker', () => {
    it('are members of the frozen sandboxView, next to render and on', async () => {
        const { view } = await startPrelude();
        expect(Object.keys(view).sort()).toEqual(['on', 'render', 'set', 'text']);
        expect(Object.isFrozen(view)).toBe(true);
    });

    it('validate their arguments: TypeError for an id that is not an element id, a text that is not a string, a set that is not an object, an unknown key or a wrong type; RangeError past the render budget', async () => {
        const { view, sent } = await startPrelude(20);
        for (const id of [undefined, null, 7, '', 'toolong', {}]) {
            expect(() => view.text(id, 'x'), String(id)).toThrow(TypeError);
            expect(() => view.set(id, { value: 'x' }), String(id)).toThrow(TypeError);
        }
        expect(() => view.text('a', 1)).toThrow(TypeError);
        expect(() => view.text('a', undefined)).toThrow(TypeError);
        expect(() => view.text('a', 'x'.repeat(21))).toThrow(RangeError);
        for (const fields of [undefined, null, 'value', 5, ['value']]) expect(() => view.set('a', fields), String(fields)).toThrow(TypeError);
        expect(() => view.set('a', { values: 'x' })).toThrowError(new TypeError('sandboxView.set: unknown key "values"; the keys are value, checked and focus'));
        expect(() => view.set('a', { value: 1 })).toThrow(TypeError);
        expect(() => view.set('a', { checked: 'yes' })).toThrow(TypeError);
        expect(() => view.set('a', { focus: 1 })).toThrow(TypeError);
        expect(() => view.set('a', { value: 'x'.repeat(21) })).toThrow(RangeError);
        expect(sent()).toEqual([]); // nothing refused was sent
    });

    it('go over the render port with its flow control: one in flight; text and render to one target are one slot, the latest wins; consecutive sets of one id merge; nothing is reordered', async () => {
        const { view, sent, ack } = await startPrelude();
        view.text('a', '<b>x</b>');
        expect(sent()).toEqual([{ type: 'VIEW_TEXT', into: 'a', text: '<b>x</b>' }]);
        view.render('<p>1</p>', 'b');
        view.text('b', 'two'); // replaces the queued render of b
        view.set('c', { value: 'v' });
        view.set('c', { checked: true }); // merged into the queued set of c
        view.render('<i>', 'd');
        view.set('c', { focus: true }); // after the render of d: not merged across it
        view.set('e', {}); // nothing to set: nothing sent
        expect(sent()).toHaveLength(1);
        for (let i = 0; i < 5; i++) ack();
        expect(sent()).toEqual([
            { type: 'VIEW_TEXT', into: 'a', text: '<b>x</b>' },
            { type: 'VIEW_TEXT', into: 'b', text: 'two' },
            { type: 'VIEW_SET', id: 'c', value: 'v', checked: true },
            { type: 'VIEW_RENDER', html: '<i>', into: 'd' },
            { type: 'VIEW_SET', id: 'c', focus: true },
        ]);
    });

    it('read each field once and send only copies of the primitives: a getter runs once, extra prototype keys are not read', async () => {
        const { view, sent } = await startPrelude();
        let reads = 0;
        const fields = Object.create({ inherited: 'x' }, { value: { enumerable: true, get: () => { reads++; return 'v'; } } });
        view.set('a', fields);
        expect(reads).toBe(1);
        expect(sent()).toEqual([{ type: 'VIEW_SET', id: 'a', value: 'v' }]);
    });

    it("say in the guest's log what the view refused, by name", async () => {
        const { view, ack, lines } = await startPrelude();
        view.text('a', 'x');
        view.set('b', { focus: true });
        view.render('<p>', 'c');
        ack(['VIEW_MAX_CHARACTERS']);
        ack(['VIEW_FOCUS']);
        ack(['VIEW_MAX_ELEMENTS']);
        expect(lines).toEqual([
            '[Sandbox] sandboxView.text: the view refused it: the view would hold more than 1000 characters; nothing of it was applied.',
            "[Sandbox] sandboxView.set: the view refused focus: the user's focus is not in the sandbox (they last interacted with the host page, or the window is not focused); the rest was applied.",
            '[Sandbox] sandboxView.render: the view refused a render: the view would hold more than 100 elements; nothing of it was applied.',
        ]);
    });
});

describe('R4-5: the view applies text and set: text is assigned, never parsed; values and checked states of form controls; focus only while the user\'s focus is in the sandbox', () => {
    const originalWorker = (globalThis as any).Worker;
    let focused = true;
    afterEach(() => {
        (globalThis as any).Worker = originalWorker;
        delete (globalThis as any).__sandboxViewRuns;
        document.body.replaceChildren();
    });

    // The bootstrap in this document with a fake Worker; `maxCharacters` replaces the view's character budget.
    const startView = async (html: string, maxCharacters?: number) => {
        const { VIEW_OPTIONS, viewBootstrapSource } = await import('@src/lib/in-sandbox-view');
        const { inSandboxFiles } = await import('@src/lib/in-sandbox-files');
        focused = true;
        vi.spyOn(Document.prototype, 'hasFocus').mockImplementation(() => focused);
        const workers: MessagePort[][] = [];
        (globalThis as any).Worker = class {
            onerror: unknown = null;
            postMessage(_message: unknown, transfer: MessagePort[]) { workers.push(transfer); }
        };
        const options = maxCharacters ? { ...VIEW_OPTIONS, render: { ...VIEW_OPTIONS.render, maxCharacters } } : VIEW_OPTIONS;
        new Function(viewBootstrapSource(options))();
        const logic = new MessageChannel(), view = new MessageChannel();
        window.dispatchEvent(new MessageEvent('message', { data: { type: 'INIT_VIEW', workerSource: 'void 0', viewFiles: [], html }, source: window, ports: [logic.port1, view.port1] }));
        const render = workers[0]![1]!;
        const acks: any[] = [];
        render.onmessage = (event) => { if (event.data.type === 'VIEW_ACK') acks.push(event.data); };
        render.postMessage({ type: 'VIEW_STARTED', entryErrors: 0 });
        const send = async (frame: object) => {
            const before = acks.length;
            render.postMessage(frame);
            for (let i = 0; i < 300 && acks.length === before; i++) await new Promise(resolve => setTimeout(resolve, 10));
            expect(acks.length).toBe(before + 1);
            return acks[acks.length - 1];
        };
        return { send };
    };
    const $ = (id: string) => document.getElementById(id) as any;

    it('text: the string becomes the element\'s only text, markup and all, and nothing is parsed; an unknown id or one outside the body is dropped and acknowledged', async () => {
        const { send } = await startView('<p id="out"><b>old</b></p>');
        const hostile = '<img src=x onerror=alert(1)><script>alert(2)</script> & </p>';
        expect(await send({ type: 'VIEW_TEXT', into: 'out', text: hostile })).toEqual({ type: 'VIEW_ACK' });
        expect([$('out').textContent, $('out').children.length, $('out').childNodes.length, document.querySelectorAll('img, script').length]).toEqual([hostile, 0, 1, 0]);
        expect(await send({ type: 'VIEW_TEXT', into: 'nope', text: 'x' })).toEqual({ type: 'VIEW_ACK' });
        expect(await send({ type: 'VIEW_TEXT', into: 'out', text: '' })).toEqual({ type: 'VIEW_ACK' });
        expect($('out').childNodes.length).toBe(0);
        expect(await send({ type: 'VIEW_TEXT', into: 'out', text: 1 })).toEqual({ type: 'VIEW_ACK' }); // malformed: refused, never a stall
        expect($('out').textContent).toBe('');
    });

    it('text counts against the view\'s characters as it serializes (escaped), over the document it would leave', async () => {
        const { send } = await startView('<p id="a"></p><p id="b">' + 'x'.repeat(50) + '</p>', 100);
        expect(document.body.innerHTML.length).toBe('<p id="a"></p><p id="b"></p>'.length + 50);
        expect(await send({ type: 'VIEW_TEXT', into: 'a', text: '&'.repeat(4) })).toEqual({ type: 'VIEW_ACK' }); // 20 characters serialized: 98
        expect(await send({ type: 'VIEW_TEXT', into: 'a', text: '&'.repeat(5) })).toEqual({ type: 'VIEW_ACK', refused: ['VIEW_MAX_CHARACTERS'] }); // 25: 103, over
        expect($('a').textContent).toBe('&&&&');
        expect(await send({ type: 'VIEW_TEXT', into: 'b', text: '' })).toEqual({ type: 'VIEW_ACK' }); // frees b's 50
        expect(await send({ type: 'VIEW_TEXT', into: 'a', text: '&'.repeat(10) })).toEqual({ type: 'VIEW_ACK' });
    });

    it('set: value of an input (shown and default), a textarea, a select and an output; checked of a checkbox; nothing on an element without a value; a file input is left alone', async () => {
        const { send } = await startView('<input id="i"><textarea id="t">old</textarea><select id="s"><option value="a">a</option><option value="b">b</option></select><output id="o"><b>x</b></output><input id="c" type="checkbox"><p id="p">p</p><input id="f" type="file">');
        for (const [id, value] of [['i', 'Ada'], ['t', 'two\nlines'], ['s', 'b'], ['o', '<i>7</i>'], ['p', 'nope'], ['f', 'C:\\x']]) expect(await send({ type: 'VIEW_SET', id, value })).toEqual({ type: 'VIEW_ACK' });
        expect(await send({ type: 'VIEW_SET', id: 'c', checked: true })).toEqual({ type: 'VIEW_ACK' });
        expect([$('i').value, $('i').getAttribute('value'), $('t').value, $('t').defaultValue, $('s').value, $('o').value, $('o').children.length, $('c').checked, $('p').textContent, $('f').value]).toEqual(['Ada', 'Ada', 'two\nlines', 'two\nlines', 'b', '<i>7</i>', 0, true, 'p', '']);
        expect(await send({ type: 'VIEW_SET', id: 'c', checked: false })).toEqual({ type: 'VIEW_ACK' });
        expect($('c').checked).toBe(false);
        expect(await send({ type: 'VIEW_SET', id: 'nope', value: 'x' })).toEqual({ type: 'VIEW_ACK' });
    });

    it('set: a value counts against the view\'s characters as it serializes (the input\'s value attribute, the textarea\'s and output\'s text)', async () => {
        const { send } = await startView('<input id="i"><textarea id="t"></textarea>', 100);
        const base = document.body.innerHTML.length;
        expect(await send({ type: 'VIEW_SET', id: 'i', value: 'x'.repeat(100 - base - ' value=""'.length) })).toEqual({ type: 'VIEW_ACK' });
        expect(document.body.innerHTML.length).toBe(100);
        expect(await send({ type: 'VIEW_SET', id: 't', value: 'y' })).toEqual({ type: 'VIEW_ACK', refused: ['VIEW_MAX_CHARACTERS'] });
        expect($('t').value).toBe('');
        expect(await send({ type: 'VIEW_SET', id: 'i', value: 'short' })).toEqual({ type: 'VIEW_ACK' }); // replacing frees what it held
        expect(await send({ type: 'VIEW_SET', id: 't', value: 'y' })).toEqual({ type: 'VIEW_ACK' });
    });

    it('focus: only while the view has the user\'s focus (document.hasFocus()); otherwise refused by name, and nothing moves', async () => {
        const { send } = await startView('<input id="i"><button id="b">b</button><p id="p">p</p>');
        focused = false;
        expect(await send({ type: 'VIEW_SET', id: 'i', focus: true, value: 'kept' })).toEqual({ type: 'VIEW_ACK', refused: ['VIEW_FOCUS'] });
        expect([document.activeElement === $('i'), $('i').value]).toEqual([false, 'kept']); // the rest applied
        focused = true;
        expect(await send({ type: 'VIEW_SET', id: 'i', focus: true })).toEqual({ type: 'VIEW_ACK' });
        expect(document.activeElement).toBe($('i'));
        expect(await send({ type: 'VIEW_SET', id: 'b', focus: true })).toEqual({ type: 'VIEW_ACK' });
        expect(document.activeElement).toBe($('b'));
        expect(await send({ type: 'VIEW_SET', id: 'p', focus: true })).toEqual({ type: 'VIEW_ACK' }); // not focusable: nothing happens
        expect(document.activeElement).toBe($('b'));
        expect(await send({ type: 'VIEW_SET', id: 'b', focus: false })).toEqual({ type: 'VIEW_ACK' });
        expect(document.activeElement).toBe($('b'));
    });
});
