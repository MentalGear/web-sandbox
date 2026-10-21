import { describe, it, expect, vi, afterEach } from 'vitest';
import { BRIDGE_FRAME_REFUSED, createBridgeFrame, prepareBridgeFrame } from '@src/lib/bridge-frame';
import { createFetchBridge, toFetchPolicy, type FetchRecord } from '@src/lib/fetch-bridge';
import { BRIDGE_POLICY_START, BRIDGE_PREFIX } from '@src/lib/frame-documents';
import { BRIDGE_ROLE, viewBootstrapHash, viewBootstrapText } from '@src/lib/in-sandbox-view';
import { playBridgeFrame } from './check-in';

/**
 * The fetch bridge's frame, host side (BD1:ISO-1, class E-net; src/lib/bridge-frame.ts): every bridge request is made by
 * the frame's own code (in-bridge-frame.ts, run here by playBridgeFrame, since jsdom runs no frame), the host's policy
 * code decides it, and the bridge fails closed when the frame never starts. The browsers' side (the Service Worker, a
 * host fetch wrapper, `Origin: null`, the host page's policy) is test/e2e/fetch-bridge-isolation.spec.ts.
 */

const ALLOW = 'https://api.example';

function setup(options: { fetch?: (request: Request, init?: RequestInit) => Promise<Response>; timeoutMs?: number } = {}) {
    const root = document.createElement('div');
    document.body.appendChild(root);
    const policy = toFetchPolicy({ allow: [ALLOW], ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}) }, () => {})!;
    const refused = vi.fn();
    const frame = createBridgeFrame({ iframe: prepareBridgeFrame(policy.allow), parent: root, maxBytes: policy.maxBytes, startupTimeoutMs: 5000, onRefused: refused });
    const records: FetchRecord[] = [];
    const bridge = createFetchBridge({ policy, hostOrigin: 'https://host.example', onRecord: (record) => records.push(record), transport: frame.transport });
    const fetchSpy = options.fetch ? vi.spyOn(globalThis, 'fetch').mockImplementation(options.fetch as typeof fetch) : null;
    return { root, frame, bridge, records, refused, fetchSpy };
}

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    document.body.replaceChildren();
});

describe("the bridge frame's document", () => {
    it('is sandboxed to scripts alone, hidden, and holds only its policy and the hashed bootstrap in the bridge role', () => {
        const iframe = prepareBridgeFrame([ALLOW as any]);
        expect(iframe.getAttribute('sandbox')).toBe('allow-scripts');
        expect(iframe.hidden).toBe(true);
        const doc = iframe.srcdoc;
        expect(doc.startsWith(BRIDGE_PREFIX)).toBe(true);
        const parsed = new DOMParser().parseFromString(doc, 'text/html');
        const csp = parsed.querySelector('meta[http-equiv="Content-Security-Policy"]')!.getAttribute('content')!;
        expect(csp.startsWith(BRIDGE_POLICY_START)).toBe(true);
        expect(csp).toContain(`script-src ${viewBootstrapHash()};`);
        expect(csp).toContain(`connect-src ${ALLOW};`);
        expect(csp).not.toContain('upgrade-insecure-requests');
        const scripts = [...parsed.querySelectorAll('script')];
        expect(scripts.map(script => [script.getAttribute('data-role'), script.textContent])).toEqual([[BRIDGE_ROLE, viewBootstrapText()]]);
        expect(parsed.body.childNodes).toHaveLength(0);
    });

    it('admits no connection at all with an empty allowlist', () => {
        const parsed = new DOMParser().parseFromString(prepareBridgeFrame([]).srcdoc, 'text/html');
        expect(parsed.querySelector('meta')!.getAttribute('content')).toContain("connect-src 'none';");
    });
});

describe('a request through the frame', () => {
    it("is made by the frame's fetch with the pinned options, its response handed over whole and recorded once", async () => {
        const { root, bridge, records, fetchSpy } = setup({ fetch: async () => new Response('hello', { status: 201, headers: { 'x-a': '1' } }) });
        playBridgeFrame(root);
        const result = await bridge.handle({ url: `${ALLOW}/data#frag`, method: 'POST', headers: [['content-type', 'text/plain']], body: 'b' });
        expect(new TextDecoder().decode(result.body)).toBe('hello');
        expect(result).toMatchObject({ status: 201, url: `${ALLOW}/data` });
        expect(result.headers).toContainEqual(['x-a', '1']);
        const [request, init] = fetchSpy!.mock.calls[0]! as [Request, RequestInit];
        expect(request.url).toBe(`${ALLOW}/data`);
        expect(request.method).toBe('POST');
        expect(request.headers.get('content-type')).toBe('text/plain');
        expect(init).toMatchObject({ credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'manual', mode: 'cors', cache: 'no-store', keepalive: false });
        expect(records).toMatchObject([{ outcome: 'ok', status: 201, bytes: 5 }]);
    });

    it('a body is read from the frame one chunk at a time, and past maxBytes the frame is told to stop: FETCH_TOO_LARGE', async () => {
        let pulled = 0;
        const chunk = new Uint8Array(400 * 1024);
        const { root, bridge, records } = setup({
            fetch: async () => new Response(new ReadableStream<Uint8Array>({ pull: (controller) => { pulled++; controller.enqueue(chunk.slice()); } }, { highWaterMark: 0 })),
        });
        playBridgeFrame(root);
        await expect(bridge.handle({ url: `${ALLOW}/big` })).rejects.toMatchObject({ code: 'FETCH_TOO_LARGE' });
        expect(records).toMatchObject([{ outcome: 'failed', code: 'FETCH_TOO_LARGE' }]);
        expect(records[0]!.bytes).toBe(3 * chunk.byteLength); // the cap (1 MiB) and one chunk
        await new Promise(resolve => setTimeout(resolve, 20));
        expect(pulled).toBeLessThanOrEqual(4); // the frame reads no further ahead than the host asks
    });

    it('teardown (close) rejects a request in flight and aborts the frame\'s fetch; the record is aborted', async () => {
        let signal: AbortSignal | null = null;
        const { root, frame, bridge, records } = setup({
            fetch: (request) => {
                signal = request.signal;
                return new Promise<Response>(() => {});
            },
        });
        playBridgeFrame(root);
        const pending = bridge.handle({ url: `${ALLOW}/slow` });
        await vi.waitFor(() => expect(signal).not.toBeNull());
        bridge.abortAll();
        frame.close();
        await expect(pending).rejects.toMatchObject({ code: 'FETCH_FAILED' });
        await vi.waitFor(() => expect(signal!.aborted).toBe(true));
        expect(records).toMatchObject([{ outcome: 'aborted', code: 'FETCH_FAILED' }]);
        expect(root.querySelector('iframe')).toBeNull();
    });
});

describe('a frame that never starts (the host page refused its script): the bridge fails closed', () => {
    it('every request is refused with FETCH_FAILED, its record says why, the embedder is told once, and nothing is fetched', async () => {
        vi.useFakeTimers();
        const { bridge, records, refused, fetchSpy } = setup({ fetch: async () => new Response('never') });
        const waiting = bridge.handle({ url: `${ALLOW}/a` });
        const settled = expect(waiting).rejects.toMatchObject({ code: 'FETCH_FAILED' });
        await vi.advanceTimersByTimeAsync(6000);
        await settled;
        await expect(bridge.handle({ url: `${ALLOW}/b` })).rejects.toMatchObject({ code: 'FETCH_FAILED' });
        expect(records.map(record => [record.outcome, record.code, record.reason])).toEqual([
            ['refused', 'FETCH_FAILED', BRIDGE_FRAME_REFUSED],
            ['refused', 'FETCH_FAILED', BRIDGE_FRAME_REFUSED],
        ]);
        expect(refused).toHaveBeenCalledTimes(1);
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('positive control: a frame that answers within the bound serves the request', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval'] });
        const { root, bridge, refused } = setup({ fetch: async () => new Response('ok') });
        playBridgeFrame(root);
        const answered = bridge.handle({ url: `${ALLOW}/a` });
        vi.useRealTimers();
        expect(new TextDecoder().decode((await answered).body)).toBe('ok');
        expect(refused).not.toHaveBeenCalled();
    });
});
