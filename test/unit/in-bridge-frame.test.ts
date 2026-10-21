import { describe, it, expect, vi, afterEach } from 'vitest';
import { BRIDGE_FRAME_OPTIONS, MAX_RESPONSE_HEAD, inBridgeFrame } from '@src/lib/in-bridge-frame';

/**
 * The bridge frame's own rules (BD1:ISO-1, class E-net; src/lib/in-bridge-frame.ts), run in the test's realm with the
 * window's `message` listener captured, a stubbed `fetch` and a fake host port, since jsdom runs no frame. They hold
 * whatever the host does: the frame takes one BRIDGE_INIT from its parent, with one port, and bounds what it posts back
 * (THREAT-MODEL, the bridge frame's row; docs/API.md, the limits table). The host's side of the same protocol is
 * test/unit/bridge-frame.test.ts.
 */

type Posted = { type: string; id?: number; code?: string };
interface FakePort { postMessage: ReturnType<typeof vi.fn>; onmessage: ((event: { data: unknown }) => void) | null }

const realm = globalThis as unknown as { addEventListener: typeof addEventListener; parent: unknown; __sandboxBridgeRuns?: number };
const PARENT = () => realm.parent;
const STRANGER = { not: 'the parent' };
const URL_ = 'https://api.example/x';

/** Runs the frame's bootstrap and returns the `message` listener it installed, with the run counter reset. */
function boot(): (event: unknown) => void {
    const saved = realm.addEventListener;
    let listener: ((event: unknown) => void) | null = null;
    realm.addEventListener = ((_type: string, given: (event: unknown) => void) => { listener = given; }) as typeof addEventListener;
    delete realm.__sandboxBridgeRuns;
    try {
        inBridgeFrame(BRIDGE_FRAME_OPTIONS);
    } finally {
        realm.addEventListener = saved;
    }
    return listener!;
}

const fakePort = (): FakePort => ({ postMessage: vi.fn(), onmessage: null });
const init = (source: unknown, ports: FakePort[], extra: object = {}) => ({
    source,
    data: { type: 'BRIDGE_INIT', maxBytes: 10, ...extra },
    ports,
    stopImmediatePropagation: vi.fn(),
});

afterEach(() => {
    vi.restoreAllMocks();
    delete realm.__sandboxBridgeRuns;
});

describe('BRIDGE_INIT: one, from the parent, with one port', () => {
    it('is accepted from the parent: BRIDGE_READY on its port, and the event stops at the frame\'s capture listener', () => {
        const listener = boot();
        const port = fakePort();
        const event = init(PARENT(), [port]);
        listener(event);
        expect(port.postMessage).toHaveBeenCalledWith({ type: 'BRIDGE_READY' }, []);
        expect(port.onmessage).toBeTypeOf('function');
        expect(event.stopImmediatePropagation).toHaveBeenCalledTimes(1);
    });

    it('is ignored from any window but the parent: no answer, no handler on the port it offered, and the event is not stopped', () => {
        const listener = boot();
        const port = fakePort();
        const event = init(STRANGER, [port]);
        listener(event);
        expect(port.postMessage).not.toHaveBeenCalled();
        expect(port.onmessage).toBeNull();
        expect(event.stopImmediatePropagation).not.toHaveBeenCalled();
    });

    it('is ignored from a stranger after the parent gave its port: the frame has one channel', () => {
        const listener = boot();
        const first = fakePort();
        const stranger = fakePort();
        listener(init(PARENT(), [first]));
        listener(init(STRANGER, [stranger]));
        expect(stranger.postMessage).not.toHaveBeenCalled();
        expect(stranger.onmessage).toBeNull();
    });

    it('a second one changes nothing, even from the parent: the first port stays the frame\'s only channel', () => {
        const listener = boot();
        const first = fakePort();
        const second = fakePort();
        listener(init(PARENT(), [first]));
        listener(init(PARENT(), [second]));
        expect(second.postMessage).not.toHaveBeenCalled();
        expect(second.onmessage).toBeNull();
        expect(first.postMessage).toHaveBeenCalledTimes(1);
    });

    it('with no port or two ports is ignored, and so is any other frame type', () => {
        const listener = boot();
        const a = fakePort();
        const b = fakePort();
        listener(init(PARENT(), []));
        listener(init(PARENT(), [a, b]));
        listener({ source: PARENT(), data: { type: 'BRIDGE_FETCH' }, ports: [a], stopImmediatePropagation() {} });
        expect(a.postMessage).not.toHaveBeenCalled();
        expect(b.postMessage).not.toHaveBeenCalled();
    });

    it('the bootstrap runs once: a second run installs no second listener', () => {
        const saved = realm.addEventListener;
        const types: string[] = [];
        realm.addEventListener = ((type: string) => { types.push(type); }) as typeof addEventListener;
        delete realm.__sandboxBridgeRuns;
        try {
            inBridgeFrame(BRIDGE_FRAME_OPTIONS);
            inBridgeFrame(BRIDGE_FRAME_OPTIONS);
        } finally {
            realm.addEventListener = saved;
        }
        expect(types).toEqual(['message']);
    });
});

/** A booted frame whose `fetch` answers `respond`, joined to a fake host port; `send` is the host's side of the port. */
function frame(respond: () => Promise<Response>, maxBytes = 10) {
    vi.spyOn(globalThis, 'fetch').mockImplementation(respond as typeof fetch);
    const listener = boot();
    const posted: Posted[] = [];
    const port = { postMessage: (data: Posted) => { posted.push(data); }, onmessage: null as ((event: { data: unknown }) => void) | null };
    listener({ source: PARENT(), data: { type: 'BRIDGE_INIT', maxBytes }, ports: [port], stopImmediatePropagation() {} });
    const send = (data: object) => port.onmessage!({ data });
    const settle = () => new Promise(resolve => setTimeout(resolve, 20));
    const request = (id = 1) => send({ type: 'BRIDGE_FETCH', id, url: URL_, method: 'GET', headers: [], body: undefined });
    return { posted, send, settle, request };
}

describe('the frame stops a body past maxBytes by itself', () => {
    it('one chunk may take the total past the cap; the next pull is answered FETCH_TOO_LARGE, not with another chunk', async () => {
        const body = new ReadableStream<Uint8Array>({ pull: (controller) => { controller.enqueue(new Uint8Array(8)); } }, { highWaterMark: 0 });
        const { posted, send, settle, request } = frame(async () => new Response(body), 10);
        request();
        await settle();
        expect(posted.map(p => p.type)).toEqual(['BRIDGE_READY', 'BRIDGE_HEAD']);
        send({ type: 'BRIDGE_PULL', id: 1 }); // 8 bytes: under the cap
        await settle();
        send({ type: 'BRIDGE_PULL', id: 1 }); // 16 bytes: past the cap, and posted
        await settle();
        expect(posted.filter(p => p.type === 'BRIDGE_CHUNK')).toHaveLength(2);
        send({ type: 'BRIDGE_PULL', id: 1 }); // the total is past the cap: refused
        await settle();
        expect(posted.at(-1)).toMatchObject({ type: 'BRIDGE_ERROR', id: 1, code: 'FETCH_TOO_LARGE' });
        expect(posted.filter(p => p.type === 'BRIDGE_CHUNK')).toHaveLength(2);
    });

    it('a BRIDGE_INIT with no usable maxBytes leaves no body readable past its first chunk', async () => {
        const body = new ReadableStream<Uint8Array>({ pull: (controller) => { controller.enqueue(new Uint8Array(1)); } }, { highWaterMark: 0 });
        const { posted, send, settle, request } = frame(async () => new Response(body), Number.NaN);
        request();
        await settle();
        send({ type: 'BRIDGE_PULL', id: 1 });
        await settle();
        send({ type: 'BRIDGE_PULL', id: 1 });
        await settle();
        expect(posted.filter(p => p.type === 'BRIDGE_CHUNK')).toHaveLength(1);
        expect(posted.at(-1)).toMatchObject({ type: 'BRIDGE_ERROR', code: 'FETCH_TOO_LARGE' });
    });
});

describe('the frame refuses a response whose head is over MAX_RESPONSE_HEAD (status text, header names and values together)', () => {
    const headOf = (init: ResponseInit) => async () => new Response(null, init);
    const refused = (posted: Posted[]) => {
        expect(posted.map(p => p.type)).toEqual(['BRIDGE_READY', 'BRIDGE_ERROR']);
        expect(posted[1]).toMatchObject({ id: 1, code: 'FETCH_TOO_LARGE' });
    };

    it('a head of exactly the limit is posted', async () => {
        const { posted, settle, request } = frame(headOf({ headers: { 'x-a': 'v'.repeat(MAX_RESPONSE_HEAD - 'x-a'.length) } }));
        request();
        await settle();
        expect(posted.map(p => p.type)).toEqual(['BRIDGE_READY', 'BRIDGE_HEAD']);
    });

    it('a header value past the limit', async () => {
        const { posted, settle, request } = frame(headOf({ headers: { 'x-a': 'v'.repeat(MAX_RESPONSE_HEAD) } }));
        request();
        await settle();
        refused(posted);
    });

    it('a status text past the limit', async () => {
        const { posted, settle, request } = frame(headOf({ status: 200, statusText: 's'.repeat(MAX_RESPONSE_HEAD + 1) }));
        request();
        await settle();
        refused(posted);
    });

    it('many headers whose names and values add up past the limit', async () => {
        const headers: Record<string, string> = {};
        for (let i = 0; i < 40; i++) headers[`x-h${i}`] = 'v'.repeat(Math.ceil(MAX_RESPONSE_HEAD / 40));
        const { posted, settle, request } = frame(headOf({ headers }));
        request();
        await settle();
        refused(posted);
    });

    it('header names alone past the limit', async () => {
        const headers: Record<string, string> = {};
        for (let i = 0; i < 20; i++) headers[`x${'n'.repeat(Math.ceil(MAX_RESPONSE_HEAD / 20))}${i}`] = '1';
        const { posted, settle, request } = frame(headOf({ headers }));
        request();
        await settle();
        refused(posted);
    });
});
