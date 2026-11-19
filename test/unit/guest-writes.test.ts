import '@src/network'; // the network build: this file tests modes and options the default build does not have (ADR-009)
import { describe, it, expect, vi, afterEach } from 'vitest';
import { GUEST_WRITES_PER_SECOND } from '@src/lib/guest-writes';
import { startWith } from './start-app';
import { commitAt } from './guest-commit';

/**
 * Guest writes on the element (backlog C5): the config, the reserved method's wiring, the overlay's lifecycle,
 * the current-port rule (AR:B4) and the listener rule (AR:B5). The overlay's own rules are in
 * src/lib/guest-writes.test.ts; the browsers in test/e2e/guest-writes.spec.ts.
 */

async function mount(config?: Record<string, unknown>) {
    const { defineWebSandbox } = await import('@src/host');
    defineWebSandbox();
    const el = document.createElement('web-sandbox') as any;
    document.body.appendChild(el);
    if (config) startWith(el, config);
    return el;
}

const settle = () => new Promise(resolve => setTimeout(resolve, 0));

// Hands the element a port of the current environment (jsdom never loads the frame) and sends sandbox:write
// requests on it, as the guest's broker would. Returns every answer frame.
function connect(el: any) {
    const { port1 } = new MessageChannel();
    el._port = port1;
    const answers: any[] = [];
    const reply = (frame: unknown) => answers.push(frame);
    let id = 0;
    const send = (request: unknown, port: MessagePort = port1) => el._onGuestMessage(port, reply, { type: 'RPC_REQ', id: ++id, method: 'sandbox:write', args: [request] }, null);
    return { port: port1, answers, send, close: () => port1.close() };
}
const write = (path: string, entry: unknown = 'x') => ({ change: 'write', path, entry });

const events = (el: HTMLElement) => {
    const heard: string[][] = [];
    el.addEventListener('fileswritten', (e) => heard.push([...(e as CustomEvent).detail.paths]));
    return heard;
};

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    document.body.replaceChildren();
});

describe('the config: only a literal true turns guest writes on', () => {
    it.each([['true'], [1], [{}]])('guestWrites: %j → start() refuses it with a TypeError: no app, no overlay', async (guestWrites) => {
        const { defineWebSandbox } = await import('@src/host');
        defineWebSandbox();
        const el = document.createElement('web-sandbox') as any;
        expect(() => startWith(el, { capabilities: ['allow-scripts'], guestWrites })).toThrow(/guestWrites must be a boolean/);
        expect([el.started, el._guestWrites]).toEqual([false, null]);
    });

    it.each([[undefined], [false]])('guestWrites: %j → off: no overlay, no feature in the bootstrap, and the method refuses FILES_NOT_ALLOWED', async (guestWrites) => {
        const el = await mount({ capabilities: ['allow-scripts'], guestWrites });
        expect(el._config.guestWrites).toBe(false);
        expect(el._guestWrites).toBeNull();
        expect(el.shadowRoot.querySelector('iframe').srcdoc).not.toContain('guestWrites&quot;:true');
        const { answers, send, close } = connect(el);
        send(write('a.txt'));
        await settle();
        expect(answers).toEqual([{ type: 'RPC_RES', id: 1, ok: false, error: expect.any(String), code: 'FILES_NOT_ALLOWED' }]);
        expect(el.listGuestWrites()).toEqual([]);
        close();
    });

    it('guestWrites: true → an overlay, and the feature reaches the bootstrap (positive control)', async () => {
        const el = await mount({ mode: 'cooperative', capabilities: ['allow-scripts'], guestWrites: true });
        const heard = events(el); // 'fileswritten' does not bubble: heard on the element
        expect(el._config.guestWrites).toBe(true);
        expect(el.shadowRoot.querySelector('iframe').srcdoc).toContain('guestWrites&quot;:true'); // inside the guest srcdoc attribute
        const { answers, send, close } = connect(el);
        send(write('a.txt'));
        await settle();
        expect(answers).toEqual([{ type: 'RPC_RES', id: 1, ok: true, value: { path: 'a.txt', change: 'write', type: 'text/plain', size: 1 } }]);
        expect(el.listGuestWrites()).toMatchObject([{ path: 'a.txt', change: 'write', type: 'text/plain', size: 1 }]);
        expect(heard).toEqual([['a.txt']]);
        close();
    });

    it('start() cannot take the reserved name: a host method named sandbox:write is refused and never runs', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const { defineWebSandbox } = await import('@src/host');
        defineWebSandbox();
        const el = document.createElement('web-sandbox') as any;
        document.body.appendChild(el);
        const forged = vi.fn(() => 'forged');
        expect(() => startWith(el, { guestWrites: true }, { methods: { 'sandbox:write': forged } })).toThrow(/reserved for the library/);
        startWith(el, { guestWrites: true });
        const { answers, send, close } = connect(el);
        send(write('a.txt'));
        await settle();
        expect(forged).not.toHaveBeenCalled();
        expect(answers[0].value).toMatchObject({ change: 'write' });
        close();
    });

    it('a raw frame that is not a broker request (the FS_WRITE frame the backlog once proposed) changes nothing', async () => {
        const el = await mount({ guestWrites: true });
        const { port, close } = connect(el);
        el._onGuestMessage(port, () => {}, { type: 'FS_WRITE', path: 'a.txt', content: 'x' }, null);
        el._onGuestMessage(port, () => {}, { type: 'RPC_RES', id: 1, ok: true, value: { path: 'a.txt', change: 'write' } }, null);
        await settle();
        expect(el.listGuestWrites()).toEqual([]);
        close();
    });
});

describe('lifecycle: discarded by the next build and on removal, kept through a termination', () => {
    const withWrite = async () => {
        const el = await mount({ guestWrites: true });
        const connection = connect(el);
        connection.send(write('a.txt'));
        await settle();
        expect(el.listGuestWrites()).toHaveLength(1);
        return { el, ...connection };
    };

    it.each([
        ['reset()', (el: any) => el.reset()],
        ['removal from the document', (el: any) => el.remove()],
    ])('%s discards it', async (_label, act) => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const { el, close } = await withWrite();
        act(el);
        expect(el.listGuestWrites()).toEqual([]);
        close();
    });

    it.each([
        ['terminate()', async (el: any) => el.terminate()],
        // the watchdog itself, armed on the environment's port and left unanswered
        ['the watchdog', async (el: any) => {
            vi.useFakeTimers();
            el._config.watchdogTimeout = 100;
            el._startWatchdog({ postMessage() {} });
            vi.advanceTimersByTime(1000);
            vi.useRealTimers();
        }],
        // the probe's expiry, for the standing environment (a termination the element starts carries its generation)
        ['the execution timeout', async (el: any) => { el._onExecutionTimeout(el._lc.gen); }],
    ])('%s keeps it: listable and committable afterwards, and the commit reaches the store', async (_label, act) => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const { el, send, answers, close } = await withWrite();
        await act(el);
        expect(el.state).toBe('terminated');
        expect(el.listGuestWrites().map((w: any) => w.path)).toEqual(['a.txt']);
        // nothing more is recorded: its port is gone, and the overlay itself is closed
        send(write('b.txt'));
        await settle();
        expect(answers).toHaveLength(1);
        expect(el._guestWrites.handle !== undefined && (() => { try { el._guestWrites.handle(write('c.txt')); } catch (e: any) { return e.code; } })()).toBe('FILES_NOT_ALLOWED');
        const changed: string[][] = [];
        el.addEventListener('fileschanged', (e: CustomEvent) => changed.push(e.detail.paths));
        commitAt(el, ['a.txt']);
        expect(changed).toEqual([['a.txt']]);
        expect(el.listFiles().map((f: any) => f.path)).toEqual(['a.txt']);
        expect(el.listGuestWrites()).toEqual([]);
        close();
    });
});

describe('review B4: a request is handled by the overlay of the environment it arrived in', () => {
    it("a frame from the previous environment's port records nothing in the next one; the current port is heard (positive control)", async () => {
        const el = await mount({ guestWrites: true });
        const old = connect(el);
        el.reset();
        const current = connect(el);
        old.send(write('stale.txt'), old.port);
        await settle();
        expect(el.listGuestWrites()).toEqual([]);
        expect(old.answers).toEqual([]);
        current.send(write('fresh.txt'));
        await settle();
        expect(el.listGuestWrites().map((w: any) => w.path)).toEqual(['fresh.txt']);
        old.close();
        current.close();
    });

    it('a request that arrived before a rebuild but runs after it (the broker calls methods in a microtask) goes to its own, closed, overlay, never the new one', async () => {
        const el = await mount({ guestWrites: true });
        const { answers, send, close } = connect(el);
        send(write('late.txt')); // looked up now, run in a microtask
        el.reset(); // synchronously, before that microtask
        await settle();
        expect(el.listGuestWrites()).toEqual([]);
        expect(answers).toMatchObject([{ ok: false, code: 'FILES_NOT_ALLOWED' }]);
        close();
    });
});

describe("review B5: a listener's reset() in 'fileswritten' is never undone", () => {
    it("the write that announced it is not acknowledged, and the new environment's overlay is empty; without the listener it is (positive control)", async () => {
        const el = await mount({ guestWrites: true });
        const { answers, send, close } = connect(el);
        send(write('first.txt'));
        await settle();
        expect(answers.map(a => a.ok)).toEqual([true]);

        el.addEventListener('fileswritten', () => el.reset(), { once: true });
        send(write('second.txt'));
        await settle();
        expect(answers.map(a => a.ok)).toEqual([true, false]); // the answer goes to the old port, refused
        expect(el.listGuestWrites()).toEqual([]);
        expect(el.state).toBe('loading');
        close();
    });

    it("a listener's terminate() stands too: the overlay that held the write is kept, closed", async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const el = await mount({ guestWrites: true });
        const { send, close } = connect(el);
        el.addEventListener('fileswritten', () => el.terminate('stopped by a listener'), { once: true });
        send(write('a.txt'));
        await settle();
        expect(el.state).toBe('terminated');
        expect(el.listGuestWrites().map((w: any) => w.path)).toEqual(['a.txt']);
        close();
    });
});

describe('the rate bounds the events', () => {
    it(`a flood dispatches at most ${GUEST_WRITES_PER_SECOND} 'fileswritten' per second; the rest are FILES_BUSY`, async () => {
        const el = await mount({ guestWrites: true });
        const heard = events(el);
        const { answers, send, close } = connect(el);
        for (let i = 0; i < GUEST_WRITES_PER_SECOND + 50; i++) send(write(`f/${i}.txt`));
        await settle();
        expect(heard).toHaveLength(GUEST_WRITES_PER_SECOND);
        expect(answers.filter(a => a.code === 'FILES_BUSY')).toHaveLength(50);
        close();
    });
});

describe('commitGuestWrites() and listGuestWrites() on the element', () => {
    it('the values are required and checked even with writes off (a TypeError for anything not listed); with writes off an empty list commits nothing and answers true', async () => {
        const el = await mount();
        expect(el.listGuestWrites()).toEqual([]);
        for (const writes of [undefined, 'a.txt', ['a.txt'], [{ path: 'a.txt', change: 'remove' }]]) {
            expect(() => el.commitGuestWrites(writes), JSON.stringify(writes)).toThrow(TypeError);
        }
        expect(el.commitGuestWrites([])).toBe(true);
        expect(el.listFiles()).toEqual([]);
    });

    it('a non-inert commit without { code: true } throws FILES_NOT_ALLOWED and fires nothing; with it, fileschanged once', async () => {
        const el = await mount({ guestWrites: true });
        const { send, close } = connect(el);
        send(write('app.js', 'void 0'));
        send(write('note.txt', 'n'));
        await settle();
        const changed: string[][] = [];
        el.addEventListener('fileschanged', (e: CustomEvent) => changed.push(e.detail.paths));
        let code: unknown;
        try { commitAt(el, ['note.txt', 'app.js']); } catch (e: any) { code = e.code; }
        expect([code, changed, el.listFiles()]).toEqual(['FILES_NOT_ALLOWED', [], []]);
        commitAt(el, ['note.txt', 'app.js'], { code: true });
        expect(changed).toEqual([['app.js', 'note.txt']]);
        close();
    });

    it("listGuestWrites() hands out copies: changing what it returned changes nothing", async () => {
        const el = await mount({ guestWrites: true });
        const { send, close } = connect(el);
        send(write('a.bin', new Uint8Array([1, 2])));
        await settle();
        el.listGuestWrites()[0].content.fill(9);
        expect(Array.from(el.listGuestWrites()[0].content)).toEqual([1, 2]);
        close();
    });
});

// I4 (docs/design/README.md): a commit stores only bytes the embedder was handed, and only while they are still what is
// pending. The commit takes the values listGuestWrites() minted and looks each one's own entry up: a value whose entry
// is not its path's pending entry now is stale, and one stale value commits nothing.
describe("I4: a commit takes the listed values, by identity of their path's current pending entry, all or none", () => {
    const withListed = async (files: Record<string, string>) => {
        const el = await mount({ guestWrites: true });
        const connection = connect(el);
        for (const [path, content] of Object.entries(files)) connection.send(write(path, content));
        await settle();
        const changed: string[][] = [];
        el.addEventListener('fileschanged', (e: CustomEvent) => changed.push([...e.detail.paths]));
        return { el, changed, listed: el.listGuestWrites() as any[], ...connection };
    };
    const files = (el: any) => el.listFiles().map((f: any) => [f.path, f.size]);

    // Each act happens after the list; the guest then writes the path again where its environment is new, so a commit
    // by path would find something pending there.
    it.each([
        ['a guest write', async (el: any, send: (r: unknown) => void) => { send(write('a.txt', 'second')); await settle(); }],
        ['a guest removal', async (el: any, send: (r: unknown) => void) => { send({ change: 'remove', path: 'a.txt' }); send(write('a.txt', 'second')); await settle(); }],
        ['a commit', async (el: any, send: (r: unknown) => void) => { expect(el.commitGuestWrites(el.listGuestWrites())).toBe(true); send(write('a.txt', 'second')); await settle(); }],
        ['reset()', async (el: any) => { el.reset(); connect(el).send(write('a.txt', 'second')); await settle(); }],
        ['a re-insertion', async (el: any) => { el.remove(); document.body.appendChild(el); connect(el).send(write('a.txt', 'second')); await settle(); }],
    ])('%s after the list leaves the listed value uncommittable: false, nothing committed, no fileschanged; the value listed now commits (positive control)', async (_label, act) => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const { el, changed, listed, send, close } = await withListed({ 'a.txt': 'one' });
        expect(listed).toMatchObject([{ path: 'a.txt', change: 'write', size: 3 }]);
        await act(el, send);
        const before = files(el);
        const heard = changed.length;
        const answer = el.commitGuestWrites(listed);
        expect(files(el)).toEqual(before); // the files first: a commit by path would have stored 'second' here
        expect(answer).toBe(false);
        expect(changed).toHaveLength(heard);
        expect(el.listGuestWrites()).toMatchObject([{ path: 'a.txt', change: 'write', size: 6 }]);

        expect(el.commitGuestWrites(el.listGuestWrites())).toBe(true);
        expect(files(el)).toEqual([['a.txt', 6]]);
        expect(changed.at(-1)).toEqual(['a.txt']);
        close();
    });

    it('a list with one stale value commits nothing and answers false; the current one alone commits (all or none)', async () => {
        const { el, changed, listed, send, close } = await withListed({ 'a.txt': 'a', 'b.txt': 'b' });
        send(write('b.txt', 'b, again'));
        await settle();
        const answer = el.commitGuestWrites(listed);
        expect([files(el), changed]).toEqual([[], []]); // the files first: a commit by path would have stored both
        expect(answer).toBe(false);
        expect(el.listGuestWrites().map((w: any) => [w.path, w.size])).toEqual([['a.txt', 1], ['b.txt', 8]]);
        expect(el.commitGuestWrites([listed[0]])).toBe(true);
        expect([files(el), changed]).toEqual([[['a.txt', 1]], [['a.txt']]]);
        close();
    });

    it('the bytes stored are the ones listed: changing a value\'s content changes nothing committed', async () => {
        const { el, listed, close } = await withListed({ 'a.txt': 'abc' });
        listed[0].content.fill(0x7a);
        expect(el.commitGuestWrites(listed)).toBe(true);
        expect(atob(el._files._files.get('a.txt').base64)).toBe('abc'); // the store's own file, as registered
        close();
    });

    it('a value is frozen, and a copy of a value is not the value: a TypeError, before anything is committed', async () => {
        const { el, changed, listed, close } = await withListed({ 'a.txt': 'a', 'b.txt': 'b' });
        const [a, b] = listed;
        expect([Object.isFrozen(a), Object.isFrozen(b)]).toEqual([true, true]);
        for (const copy of [{ ...b }, Object.freeze({ ...b }), structuredClone(b), JSON.parse(JSON.stringify(b)), new Proxy(b, {})]) {
            expect(() => el.commitGuestWrites([a, copy])).toThrow(TypeError);
        }
        expect([files(el), changed]).toEqual([[], []]);
        expect(el.commitGuestWrites([a, b])).toBe(true); // positive control
        close();
    });

    it("another element's value is foreign to this one: a TypeError, and neither element commits", async () => {
        const { el, listed, close } = await withListed({ 'a.txt': 'a' });
        const other = await withListed({ 'a.txt': 'other' });
        expect(() => el.commitGuestWrites(other.listed)).toThrow(TypeError);
        expect(() => el.commitGuestWrites([...listed, ...other.listed])).toThrow(TypeError);
        expect([files(el), files(other.el)]).toEqual([[], []]);
        expect(other.el.commitGuestWrites(other.listed)).toBe(true); // positive control
        expect(el.commitGuestWrites(listed)).toBe(true);
        close();
        other.close();
    });
});
