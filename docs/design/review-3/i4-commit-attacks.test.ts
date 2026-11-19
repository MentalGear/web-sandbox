/**
 * Review 3, probe 3 (I4): commitGuestWrites(writes) attacked with what the guest can race and what an embedder's code
 * can hand it. Run: bunx vitest run -c docs/design/review-3/vitest.config.ts
 *
 * Each case drives the default build's element as test/unit/guest-writes.test.ts does (a port of the current environment
 * handed to the element, sandbox:write requests sent on it as the guest's broker sends them).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { startWith } from '../../../test/unit/start-app';

async function mount(config?: Record<string, unknown>) {
    const { defineWebSandbox } = await import('@src/host');
    defineWebSandbox();
    const el = document.createElement('web-sandbox') as any;
    document.body.appendChild(el);
    if (config) startWith(el, config);
    return el;
}
const settle = () => new Promise(resolve => setTimeout(resolve, 0));
function connect(el: any) {
    const { port1 } = new MessageChannel();
    el._port = port1;
    const answers: any[] = [];
    let id = 0;
    const send = (request: unknown) => el._onGuestMessage(port1, (frame: unknown) => answers.push(frame), { type: 'RPC_REQ', id: ++id, method: 'sandbox:write', args: [request] }, null);
    return { answers, send, close: () => port1.close() };
}
const write = (path: string, entry: unknown = 'x') => ({ change: 'write', path, entry });
const stored = (el: any) => el.listFiles().map((f: any) => [f.path, f.size]);

afterEach(() => {
    vi.restoreAllMocks();
    document.body.replaceChildren();
});

describe('I4 under attack', () => {
    it('the same value twice in one list commits it once; a value and a second value minted from the same entry by a second list commit together', async () => {
        const el = await mount({ guestWrites: true });
        const { send, close } = connect(el);
        send(write('a.txt', 'one'));
        await settle();
        const [first] = el.listGuestWrites();
        const [again] = el.listGuestWrites();
        expect(first).not.toBe(again);
        expect(el.commitGuestWrites([first, first, again])).toBe(true);
        expect(stored(el)).toEqual([['a.txt', 3]]);
        close();
    });

    it('a reset() run by the embedder\'s own code while the list is read (a Proxy over the array, an options getter) leaves the values stale: false, nothing stored', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        for (const how of ['proxy', 'options'] as const) {
            const el = await mount({ guestWrites: true });
            const first = connect(el);
            first.send(write('a.txt', 'one'));
            await settle();
            const listed = el.listGuestWrites();
            let resetOnce = () => { resetOnce = () => {}; el.reset(); connect(el).send(write('a.txt', 'two')); };
            const writes = how === 'proxy' ? new Proxy(listed, { get(target, key, receiver) { if (key === '0') resetOnce(); return Reflect.get(target, key, receiver); } }) : listed;
            const options = how === 'options' ? { get code() { resetOnce(); return true; } } : undefined;
            expect(el.commitGuestWrites(writes, options), how).toBe(false);
            await settle();
            expect(stored(el), how).toEqual([]);
            first.close();
            document.body.replaceChildren();
        }
    });

    it('a list whose length grows while it is read, and an array subclass with its own iterator, commit only minted values: anything else is a TypeError and nothing is stored', async () => {
        const el = await mount({ guestWrites: true });
        const { send, close } = connect(el);
        send(write('a.txt', 'one'));
        send(write('b.txt', 'two'));
        await settle();
        const [a, b] = el.listGuestWrites();
        const growing: unknown[] = [a];
        const proxy = new Proxy(growing, { get(target, key, receiver) { if (key === '0') target.push({ ...b }); return Reflect.get(target, key, receiver); } });
        expect(() => el.commitGuestWrites(proxy)).toThrow(TypeError);
        class Sneaky extends Array { *[Symbol.iterator]() { yield a; yield { path: 'c.txt', change: 'write', type: 'text/plain', size: 1, content: b.content }; } }
        const sneaky = Sneaky.from([a]);
        expect(() => el.commitGuestWrites(sneaky)).toThrow(TypeError);
        expect(stored(el)).toEqual([]);
        expect(el.commitGuestWrites([a, b])).toBe(true); // positive control
        close();
    });

    it('a removal mark: listed, then reset(), is stale; listed, then terminate(), still commits (writes outlive a termination), and the guest cannot change it after the termination', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const el = await mount({ guestWrites: true });
        const c1 = connect(el);
        c1.send(write('keep.txt', 'k'));
        await settle();
        expect(el.commitGuestWrites(el.listGuestWrites())).toBe(true);
        c1.send({ change: 'remove', path: 'keep.txt' });
        await settle();
        const [mark] = el.listGuestWrites();
        expect(mark).toMatchObject({ path: 'keep.txt', change: 'remove' });
        el.terminate('probe');
        c1.send(write('keep.txt', 'after the end')); // refused: the overlay is closed
        await settle();
        expect(el.listGuestWrites()).toEqual([mark].map(m => expect.objectContaining({ path: m.path, change: m.change })));
        expect(el.commitGuestWrites([mark])).toBe(true);
        expect(stored(el)).toEqual([]);
        c1.close();
    });

    it("a value of the previous environment beside a current one: false, and the current one is not committed either (all or none)", async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const el = await mount({ guestWrites: true });
        const c1 = connect(el);
        c1.send(write('a.txt', 'old'));
        await settle();
        const [old] = el.listGuestWrites();
        el.reset();
        const c2 = connect(el);
        c2.send(write('b.txt', 'new'));
        await settle();
        const [current] = el.listGuestWrites();
        expect(el.commitGuestWrites([current, old])).toBe(false);
        expect(stored(el)).toEqual([]);
        expect(el.listGuestWrites()[0]).toMatchObject({ path: 'b.txt' });
        c1.close();
        c2.close();
    });

    it('a commit the quota refuses (a stylesheet whose references cost more than the cap) changes neither the files nor the pending list, and the other value of the list commits alone', async () => {
        const el = await mount({ guestWrites: true });
        const { send, answers, close } = connect(el);
        const sheet = 'a{b:url(a)}'.repeat(120_000); // 1.3 MB of bytes; each url() reference is charged ~73 bytes at the commit
        send(write('big.css', sheet));
        send(write('ok.txt', 'ok'));
        await settle();
        expect(answers.map(a => a.ok)).toEqual([true, true]); // the write-time quota (bytes and count only) admitted it
        const listed = el.listGuestWrites();
        let code: unknown;
        try { el.commitGuestWrites(listed); } catch (error: any) { code = error.code; }
        expect(code).toBe('FILES_QUOTA_EXCEEDED');
        expect(stored(el)).toEqual([]);
        const again = el.listGuestWrites();
        expect(again.map((w: any) => w.path)).toEqual(['big.css', 'ok.txt']);
        // the values listed before the refusal are still the current ones: the refusal touched no entry
        expect(el.commitGuestWrites([listed[1]])).toBe(true);
        expect(stored(el)).toEqual([['ok.txt', 2]]);
        // and big.css can never commit, though the guest was told its write stands
        expect(() => el.commitGuestWrites([listed[0]])).toThrow(/FILES_QUOTA_EXCEEDED|quota|bytes/i);
        close();
    });
});
