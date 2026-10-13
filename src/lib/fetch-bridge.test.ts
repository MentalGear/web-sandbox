import { describe, it, expect, vi, afterEach } from 'vitest';
import { createFetchBridge, FETCH_ERROR_CODES, isPrivateHost, toAllowedOrigin, toFetchPolicy, validateRequest, type FetchPolicy, type FetchRecord } from './fetch-bridge';

const HOST = 'https://host.example';
const policy = (overrides: Record<string, unknown> = {}): FetchPolicy => toFetchPolicy({ allow: ['https://api.example'], ...overrides }, () => {})!;
const refusalCode = (value: unknown) => (value instanceof Error ? (value as any).code : 'accepted');

describe('the fetch bridge config (backlog B5)', () => {
    it('allow takes exact origins only', () => {
        expect(toAllowedOrigin('https://api.example')).toBe('https://api.example');
        expect(toAllowedOrigin('https://API.example:443/')).toBe('https://api.example');
        expect(toAllowedOrigin('http://localhost:8080')).toBe('http://localhost:8080');
        for (const entry of ['https://api.example/v1', 'https://api.example/?q', 'https://api.example/#x', 'https://u:p@api.example',
            'https://*.example', '*', 'api.example', 'ftp://api.example', 'blob:https://api.example/x', 'data:,x', '', 42, null]) {
            expect(toAllowedOrigin(entry), String(entry)).toBeNull();
        }
    });

    it('defaults, bounds and drops what it cannot use, warning for each', () => {
        const warnings: string[] = [];
        const p = toFetchPolicy({ allow: ['https://a.example', 'https://a.example/', 'nope'], methods: ['get', 'CONNECT', 'put'], headers: ['Authorization', 'cookie', 'sec-fetch-mode', 'bad header'], maxBytes: 1e12, timeoutMs: -1, maxConcurrent: 1000 }, (m) => warnings.push(m))!;
        expect(p.allow).toEqual(['https://a.example']);
        expect(p.methods).toEqual(['GET', 'PUT']);
        expect(p.headers).toEqual(['accept', 'accept-language', 'content-language', 'content-type', 'authorization']);
        expect(p.maxBytes).toBe(32 * 1024 * 1024);
        expect(p.timeoutMs).toBe(10000);
        expect(p.maxConcurrent).toBe(16);
        expect(warnings).toHaveLength(5);
        expect(Object.isFrozen(p) && Object.isFrozen(p.allow)).toBe(true);

        expect(toFetchPolicy({ allow: [] }, () => {})).toMatchObject({ allow: [], methods: ['GET', 'HEAD', 'POST'], maxBytes: 1024 * 1024, timeoutMs: 10000, maxConcurrent: 4 });
        for (const off of [undefined, null, true, 'https://a.example', ['https://a.example']]) expect(toFetchPolicy(off, () => {})).toBeNull();
    });
});

describe('isPrivateHost (backlog B5): loopback, private, link-local and localhost names, as the URL parser writes them', () => {
    const hostOf = (url: string) => new URL(url).hostname;
    it('recognises every spelling the URL parser canonicalises', () => {
        for (const url of ['https://localhost', 'https://LOCALHOST.', 'https://a.b.localhost', 'https://127.0.0.1', 'https://127.1', 'https://2130706433',
            'https://0x7f.0.0.1', 'https://0177.0.0.1', 'https://0.0.0.0', 'https://10.1.2.3', 'https://100.64.0.1', 'https://169.254.169.254',
            'https://172.16.0.1', 'https://172.31.255.255', 'https://192.168.1.1', 'https://198.18.0.1', 'https://224.0.0.1', 'https://255.255.255.255',
            'https://[::1]', 'https://[::]', 'https://[::ffff:127.0.0.1]', 'https://[::ffff:10.0.0.1]', 'https://[fc00::1]', 'https://[fd12:3456::1]',
            'https://[fe80::1]', 'https://[ff02::1]']) {
            expect(isPrivateHost(hostOf(url)), url).toBe(true);
        }
    });
    it('leaves public names and addresses alone', () => {
        for (const url of ['https://api.example', 'https://localhost.example', 'https://8.8.8.8', 'https://172.32.0.1', 'https://100.128.0.1',
            'https://192.169.0.1', 'https://[2001:db8::1]', 'https://[::ffff:8.8.8.8]']) {
            expect(isPrivateHost(hostOf(url)), url).toBe(false);
        }
    });
});

describe('validateRequest (backlog B5)', () => {
    it('accepts an allowlisted request and drops the fragment', () => {
        const valid = validateRequest({ url: 'https://api.example/x?y#z', method: 'post', headers: [['Content-Type', 'text/plain']], body: 'hi' }, policy(), HOST);
        expect(valid).not.toBeInstanceOf(Error);
        expect((valid as any).url.href).toBe('https://api.example/x?y');
        expect((valid as any).method).toBe('POST');
        expect((valid as any).headers).toEqual([['content-type', 'text/plain']]);
    });

    it('refuses everything else with FETCH_NOT_ALLOWED, and an oversized body with FETCH_TOO_LARGE', () => {
        const cases: [unknown, string][] = [
            [null, 'FETCH_NOT_ALLOWED'], ['https://api.example/', 'FETCH_NOT_ALLOWED'], [{ url: 42 }, 'FETCH_NOT_ALLOWED'],
            [{ url: '/relative' }, 'FETCH_NOT_ALLOWED'], [{ url: 'https://other.example/' }, 'FETCH_NOT_ALLOWED'],
            [{ url: 'http://api.example/' }, 'FETCH_NOT_ALLOWED'], [{ url: 'https://api.example:8443/' }, 'FETCH_NOT_ALLOWED'],
            [{ url: 'https://u:p@api.example/' }, 'FETCH_NOT_ALLOWED'], [{ url: 'blob:https://api.example/x' }, 'FETCH_NOT_ALLOWED'],
            [{ url: `${HOST}/` }, 'FETCH_NOT_ALLOWED'], [{ url: 'https://127.0.0.1/' }, 'FETCH_NOT_ALLOWED'],
            [{ url: 'https://api.example/', method: 'PUT' }, 'FETCH_NOT_ALLOWED'], [{ url: 'https://api.example/', method: 'CONNECT' }, 'FETCH_NOT_ALLOWED'],
            [{ url: 'https://api.example/', method: 7 }, 'FETCH_NOT_ALLOWED'],
            [{ url: 'https://api.example/', headers: [['cookie', 'a=b']] }, 'FETCH_NOT_ALLOWED'],
            [{ url: 'https://api.example/', headers: [['authorization', 'x']] }, 'FETCH_NOT_ALLOWED'],
            [{ url: 'https://api.example/', headers: [['accept', 'a\r\nb']] }, 'FETCH_NOT_ALLOWED'],
            [{ url: 'https://api.example/', headers: { accept: 'x' } }, 'FETCH_NOT_ALLOWED'],
            [{ url: 'https://api.example/', headers: [['accept']] }, 'FETCH_NOT_ALLOWED'],
            [{ url: 'https://api.example/', body: 'x' }, 'FETCH_NOT_ALLOWED'], // GET with a body
            [{ url: 'https://api.example/', method: 'POST', body: { a: 1 } }, 'FETCH_NOT_ALLOWED'],
            [{ url: 'https://api.example/', method: 'POST', body: 'x'.repeat(1024 * 1024 + 1) }, 'FETCH_TOO_LARGE'],
            [{ url: 'https://api.example/', method: 'POST', body: new Uint8Array(1024 * 1024 + 1) }, 'FETCH_TOO_LARGE'],
        ];
        for (const [request, code] of cases) expect(refusalCode(validateRequest(request, policy(), HOST)), JSON.stringify(request)?.slice(0, 80)).toBe(code);
    });

    it('allows what the policy lists: the host origin, a loopback origin, extra methods and headers', () => {
        const p = policy({ allow: [HOST, 'http://127.0.0.1:8080'], methods: ['GET', 'DELETE'], headers: ['authorization'] });
        expect(refusalCode(validateRequest({ url: `${HOST}/x` }, p, HOST))).toBe('accepted');
        expect(refusalCode(validateRequest({ url: 'http://127.1:8080/x', method: 'DELETE', headers: [['Authorization', 'Bearer t']] }, p, HOST))).toBe('accepted');
    });
});

describe('createFetchBridge (backlog B5)', () => {
    afterEach(() => vi.useRealTimers());

    // A response whose body arrives in the given chunks; `pulled` counts the chunks the bridge read.
    function streamed(chunks: number[], init: ResponseInit = {}) {
        const state = { pulled: 0, cancelled: false };
        let index = 0;
        const body = new ReadableStream<Uint8Array>({
            pull(controller) {
                if (index >= chunks.length) { controller.close(); return; }
                state.pulled++;
                controller.enqueue(new Uint8Array(chunks[index++]!));
            },
            cancel() { state.cancelled = true; },
        }, { highWaterMark: 0 });
        return { response: new Response(body, init), state };
    }

    function bridgeWith(fetchImpl: (url: string, init: RequestInit) => Promise<Response>, overrides: Record<string, unknown> = {}) {
        const records: FetchRecord[] = [];
        const calls: { url: string; init: RequestInit }[] = [];
        const bridge = createFetchBridge({
            policy: policy(overrides), hostOrigin: HOST, onRecord: (r) => records.push(r),
            fetchImpl: ((url: string, init: RequestInit) => { calls.push({ url, init }); return fetchImpl(url, init); }) as any,
        });
        return { bridge, records, calls };
    }

    it('makes the request under the bridge discipline and reports it once', async () => {
        const { bridge, records, calls } = bridgeWith(async () => new Response('hello', { status: 201, headers: { 'x-a': 'b' } }));
        const result = await bridge.handle({ url: 'https://api.example/x#f', method: 'POST', headers: [['content-type', 'text/plain']], body: 'hi', credentials: 'include', redirect: 'follow', mode: 'no-cors' });

        expect(result.status).toBe(201);
        expect(new TextDecoder().decode(result.body)).toBe('hello');
        expect(result.headers).toContainEqual(['x-a', 'b']);
        expect(calls).toHaveLength(1);
        expect(calls[0]!.url).toBe('https://api.example/x');
        expect(calls[0]!.init).toMatchObject({ method: 'POST', credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'manual', mode: 'cors', cache: 'no-store', keepalive: false });
        expect(records).toEqual([expect.objectContaining({ method: 'POST', url: 'https://api.example/x', outcome: 'ok', status: 201, bytes: 5 })]);
    });

    it('refuses without calling fetch, and reports the refusal', async () => {
        const { bridge, records, calls } = bridgeWith(async () => new Response('x'));
        await expect(bridge.handle({ url: 'https://other.example/' })).rejects.toMatchObject({ code: 'FETCH_NOT_ALLOWED' });
        expect(calls).toEqual([]);
        expect(records).toEqual([expect.objectContaining({ outcome: 'refused', code: 'FETCH_NOT_ALLOWED', url: 'https://other.example/', method: 'GET', bytes: 0 })]);
    });

    it('stops reading as soon as the body passes maxBytes: the cap plus one chunk, then cancels', async () => {
        const chunk = 40 * 1024;
        const { response, state } = streamed(new Array(100).fill(chunk));
        const { bridge, records, calls } = bridgeWith(async () => response, { maxBytes: 64 * 1024 });
        await expect(bridge.handle({ url: 'https://api.example/big' })).rejects.toMatchObject({ code: 'FETCH_TOO_LARGE' });
        expect(state.pulled).toBe(2);
        expect(state.cancelled).toBe(true);
        expect(records[0]).toMatchObject({ outcome: 'failed', code: 'FETCH_TOO_LARGE', bytes: 2 * chunk });
        expect((calls[0]!.init.signal as AbortSignal).aborted).toBe(true);
    });

    it('refuses a declared Content-Length over the cap before reading anything, and never trusts a small one', async () => {
        const declared = streamed([10, 10], { headers: { 'content-length': String(2 * 1024 * 1024) } });
        const { bridge } = bridgeWith(async () => declared.response);
        await expect(bridge.handle({ url: 'https://api.example/declared' })).rejects.toMatchObject({ code: 'FETCH_TOO_LARGE' });
        expect(declared.state.pulled).toBe(0);

        const lying = streamed([600 * 1024, 600 * 1024], { headers: { 'content-length': '10' } });
        const second = bridgeWith(async () => lying.response);
        await expect(second.bridge.handle({ url: 'https://api.example/lying' })).rejects.toMatchObject({ code: 'FETCH_TOO_LARGE' });
    });

    it('refuses a redirect with FETCH_REDIRECT and does not follow it', async () => {
        const { bridge, records, calls } = bridgeWith(async () => new Response(null, { status: 302, headers: { location: 'https://evil.example/' } }));
        await expect(bridge.handle({ url: 'https://api.example/r' })).rejects.toMatchObject({ code: 'FETCH_REDIRECT' });
        expect(calls).toHaveLength(1);
        expect(records[0]).toMatchObject({ outcome: 'failed', code: 'FETCH_REDIRECT' });
    });

    it('a network failure is FETCH_FAILED, and a timeout aborts the request with FETCH_TIMEOUT', async () => {
        const failing = bridgeWith(async () => { throw new TypeError('Failed to fetch'); });
        await expect(failing.bridge.handle({ url: 'https://api.example/' })).rejects.toMatchObject({ code: 'FETCH_FAILED' });

        vi.useFakeTimers();
        const hanging = bridgeWith((_url, init) => new Promise((_, reject) => init.signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))), { timeoutMs: 1000 });
        const pending = hanging.bridge.handle({ url: 'https://api.example/slow' });
        const settled = expect(pending).rejects.toMatchObject({ code: 'FETCH_TIMEOUT' });
        await vi.advanceTimersByTimeAsync(1000);
        await settled;
        expect(hanging.records[0]).toMatchObject({ outcome: 'failed', code: 'FETCH_TIMEOUT' });
    });

    it('caps concurrent requests with FETCH_BUSY, and abortAll() aborts every one in flight and refuses later ones', async () => {
        const { bridge, records, calls } = bridgeWith((_url, init) => new Promise((_, reject) => init.signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))), { maxConcurrent: 2 });
        const first = bridge.handle({ url: 'https://api.example/1' });
        const second = bridge.handle({ url: 'https://api.example/2' });
        await expect(bridge.handle({ url: 'https://api.example/3' })).rejects.toMatchObject({ code: 'FETCH_BUSY' });

        bridge.abortAll();
        await expect(first).rejects.toMatchObject({ code: 'FETCH_FAILED' });
        await expect(second).rejects.toMatchObject({ code: 'FETCH_FAILED' });
        await expect(bridge.handle({ url: 'https://api.example/4' })).rejects.toMatchObject({ code: 'FETCH_FAILED' });
        expect(calls.map(c => (c.init.signal as AbortSignal).aborted)).toEqual([true, true]);
        expect(records.map(r => r.outcome)).toEqual(['refused', 'aborted', 'aborted', 'refused']);
    });

    it('clamps what the guest supplied before reporting it', async () => {
        const { bridge, records } = bridgeWith(async () => new Response('x'));
        await bridge.handle({ url: 'x'.repeat(10000), method: '<script>' }).catch(() => {});
        await bridge.handle({ url: 'https://other.example/a#secret-fragment', method: 'get' }).catch(() => {});
        expect(records[0]).toMatchObject({ url: 'x'.repeat(2048), method: '' });
        expect(records[1]).toMatchObject({ url: 'https://other.example/a', method: 'GET' });
        expect(Object.isFrozen(records[0])).toBe(true);
    });

    it('the codes are the closed set the broker forwards', () => {
        expect(FETCH_ERROR_CODES).toEqual(['FETCH_NOT_ALLOWED', 'FETCH_BUSY', 'FETCH_REDIRECT', 'FETCH_TOO_LARGE', 'FETCH_TIMEOUT', 'FETCH_FAILED']);
    });
});
