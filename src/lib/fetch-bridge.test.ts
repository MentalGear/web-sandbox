import { describe, it, expect, vi, afterEach } from 'vitest';
import { normaliseConfig } from './config-schema';
import { createFetchBridge, FETCH_ERROR_CODES, FETCH_ORIGIN_RULES, FETCH_OUTCOMES, isPrivateHost, PRIVATE_NAME_SUFFIXES, toFetchPolicy, validateRequest, type FetchPolicy, type FetchRecord } from './fetch-bridge';

const HOST = 'https://host.example';
// a host page that is itself on a loopback host: a loopback, private or link-local entry is kept only for one (PRIVATE_NETWORK_REASON)
const LOCAL_PAGE = 'http://localhost:3000';
const policy = (overrides: Record<string, unknown> = {}): FetchPolicy => toFetchPolicy({ allow: ['https://api.example'], ...overrides }, () => {})!;
const refusalCode = (value: unknown) => (value instanceof Error ? (value as any).code : 'accepted');

describe('the fetch bridge config (backlog B5)', () => {
    it('allow takes exact origins only, through the one origin parser (origin.ts)', () => {
        const allowed = (entry: unknown) => toFetchPolicy({ allow: [entry] }, () => {}, LOCAL_PAGE)!.allow[0] ?? null;
        expect(allowed('https://api.example')).toBe('https://api.example');
        expect(allowed('https://API.example:443/')).toBe('https://api.example');
        expect(allowed('http://localhost:8080')).toBe('http://localhost:8080');
        expect(allowed('http://api.example:8080')).toBe('http://api.example:8080');
        expect(FETCH_ORIGIN_RULES).toEqual({ anyHost: ['https:', 'http:'], loopbackOnly: [] });
        for (const entry of ['https://api.example/v1', 'https://api.example/?q', 'https://api.example/#x', 'https://u:p@api.example',
            'https://*.example', '*', 'api.example', 'ftp://api.example', 'blob:https://api.example/x', 'data:,x', '', 42, null,
            // what the URL parser would rewrite into another spelling of some origin (ADR-007)
            'https://api.example.', 'https://127.1', 'https://a%2eexample', ' https://api.example', 'https://api.exa\tmple', 'https://bücher.example', 'https://[::1]:8080']) {
            expect(allowed(entry), String(entry)).toBeNull();
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

describe('isPrivateHost: the names that are private by convention (PRIVATE_NAME_SUFFIXES, each with its reason)', () => {
    const hostOf = (url: string) => new URL(url).hostname;
    it('every listed suffix, itself and under any depth, in any case, with or without the root dot, and nothing that only contains it', () => {
        expect(PRIVATE_NAME_SUFFIXES.map(row => row.suffix)).toEqual(expect.arrayContaining(['localhost', 'local', 'internal', 'lan', 'home.arpa']));
        expect(new Set(PRIVATE_NAME_SUFFIXES.map(row => row.suffix)).size).toBe(PRIVATE_NAME_SUFFIXES.length);
        for (const { suffix, reason } of PRIVATE_NAME_SUFFIXES) {
            expect(reason.length, suffix).toBeGreaterThan(10);
            for (const url of [`https://${suffix}`, `https://x.${suffix}`, `https://a.b.${suffix}`, `https://X.${suffix.toUpperCase()}.`]) expect(isPrivateHost(hostOf(url)), url).toBe(true);
            for (const url of [`https://${suffix}.example`, `https://x${suffix}.example`, `https://x.${suffix}x.example`, `https://x-${suffix}.example`]) expect(isPrivateHost(hostOf(url)), url).toBe(false);
        }
    });
    it('the names the embedder meets: mDNS, containers, cloud metadata, routers, a single label', () => {
        for (const url of ['https://printer.local', 'https://host.docker.internal', 'https://kubernetes.docker.internal', 'https://metadata.google.internal', 'https://router.lan',
            'https://nas.home.arpa', 'https://intranet', 'https://router', 'https://a', 'https://wiki.corp', 'https://localhost.localdomain']) {
            expect(isPrivateHost(hostOf(url)), url).toBe(true);
        }
        for (const url of ['https://api.example', 'https://local.example', 'https://internal.example.com', 'https://lan.example', 'https://home.example', 'https://arpa.example', 'https://example.com']) {
            expect(isPrivateHost(hostOf(url)), url).toBe(false);
        }
    });
    it('both call sites use it: the bridge refuses an unlisted one with the private-host reason; from a page on one an allow entry and an origins entry warn and are kept, from any other they are dropped with a warning', () => {
        for (const origin of ['https://printer.local', 'https://host.docker.internal', 'https://nas.home.arpa', 'https://intranet']) {
            const refused = validateRequest({ url: `${origin}/x` }, policy(), HOST);
            expect(refusalCode(refused), origin).toBe('FETCH_NOT_ALLOWED');
            expect((refused as any).reason, origin).toBe('a loopback, private or link-local host, which is not in fetchBridge.allow');
            const warnings: string[] = [];
            toFetchPolicy({ allow: [origin] }, (message) => warnings.push(message), LOCAL_PAGE);
            expect(warnings, origin).toEqual([expect.stringContaining(`fetchBridge.allow lists ${origin}, a loopback, private or link-local host`)]);
            const reach = normaliseConfig({ mode: 'cooperative', origins: { connect: [origin] } }, { hostOrigin: LOCAL_PAGE, hostSites: [LOCAL_PAGE] }).warnings.filter(message => message.includes(' lists '));
            expect(reach, origin).toEqual([expect.stringContaining(`origins.connect lists ${origin} (a loopback, private or link-local host)`)]);
            const away: string[] = [];
            expect(toFetchPolicy({ allow: [origin] }, (message) => away.push(message), HOST)!.allow, origin).toEqual([]);
            expect(away, origin).toEqual([expect.stringContaining(`fetchBridge.allow dropped ${origin}, a loopback, private or link-local host`)]);
            const dropped = normaliseConfig({ mode: 'cooperative', origins: { connect: [origin] } }, { hostOrigin: HOST, hostSites: [HOST] });
            expect(dropped.value!.origins.connect, origin).toEqual([]);
            expect(dropped.warnings.filter(message => message.includes(' dropped ')), origin).toEqual([expect.stringContaining(`origins.connect dropped ${origin} (a loopback, private or link-local host)`)]);
        }
        const none = normaliseConfig({ mode: 'cooperative', origins: { connect: ['https://api.example'] } }, { hostOrigin: HOST, hostSites: [HOST] }).warnings.filter(message => message.includes(' lists '));
        expect(none).toEqual([]);
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
            [{ url: 'https://api.example/', headers: [['accept', 'x'.repeat(8193)]] }, 'FETCH_NOT_ALLOWED'],
            // a value's syntax (CR, LF, NUL, above U+00FF) is the Request constructor's: test/unit/channel-guarantees.test.ts, B6
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
        const p = toFetchPolicy({ allow: [HOST, 'http://127.0.0.1:8080'], methods: ['GET', 'DELETE'], headers: ['authorization'] }, () => {}, LOCAL_PAGE)!;
        expect(refusalCode(validateRequest({ url: `${HOST}/x` }, p, HOST))).toBe('accepted');
        expect(refusalCode(validateRequest({ url: 'http://127.1:8080/x', method: 'DELETE', headers: [['Authorization', 'Bearer t']] }, p, HOST))).toBe('accepted');
    });
});

describe('the header rules of a request (BD2:TST-7, class C)', () => {
    // the names the platform forbids a script to set (the fetch spec's forbidden request-header names): a policy cannot list them, and a request cannot carry them
    const FORBIDDEN = ['host', 'origin', 'referer', 'cookie', 'proxy-authorization', 'proxy-anything', 'sec-fetch-site', 'sec-ch-ua', 'content-length', 'connection', 'transfer-encoding', 'upgrade', 'via', 'te', 'date'];

    it('a policy drops each forbidden name from its headers list, with a warning', () => {
        for (const name of FORBIDDEN) {
            const warnings: string[] = [];
            const p = toFetchPolicy({ allow: ['https://api.example'], headers: [name, 'authorization'] }, message => warnings.push(message))!;
            expect(p.headers, name).not.toContain(name);
            expect(p.headers, name).toContain('authorization');
            expect(warnings.some(message => message.includes('was dropped')), name).toBe(true);
        }
    });

    it('a request is refused for each forbidden name, listed or not, in any letter case', () => {
        for (const name of FORBIDDEN) {
            expect(refusalCode(validateRequest({ url: 'https://api.example/', headers: [[name.toUpperCase(), 'x']] }, policy(), HOST)), name).toBe('FETCH_NOT_ALLOWED');
            expect(refusalCode(validateRequest({ url: 'https://api.example/', headers: [[name, 'x']] }, policy({ headers: [name] }), HOST)), `${name}, listed`).toBe('FETCH_NOT_ALLOWED');
        }
    });

    it('at most 64 headers: 64 pass, 65 are refused', () => {
        const p = policy({ headers: ['x-a'] });
        const pairs = (count: number): [string, string][] => Array.from({ length: count }, () => ['x-a', 'v']);
        expect(refusalCode(validateRequest({ url: 'https://api.example/', headers: pairs(64) }, p, HOST))).toBe('accepted');
        expect(refusalCode(validateRequest({ url: 'https://api.example/', headers: pairs(65) }, p, HOST))).toBe('FETCH_NOT_ALLOWED');
        expect(refusalCode(validateRequest({ url: 'https://api.example/', headers: pairs(6400) }, p, HOST))).toBe('FETCH_NOT_ALLOWED');
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

    // The transport is given the Request the bridge built (AR:B6): the calls record what it carries.
    function bridgeWith(respond: (request: Request) => Promise<Response>, overrides: Record<string, unknown> = {}) {
        const records: FetchRecord[] = [];
        const calls: { url: string; init: RequestInit; request: Request }[] = [];
        const bridge = createFetchBridge({
            policy: policy(overrides), hostOrigin: HOST, onRecord: (r) => records.push(r),
            transport: ((request: Request) => {
                const { method, credentials, referrerPolicy, redirect, mode, cache, keepalive, signal } = request;
                calls.push({ url: request.url, init: { method, credentials, referrerPolicy, redirect, mode, cache, keepalive, signal }, request });
                return respond(request);
            }) as any,
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

    it('a response without a body is never too large, whatever Content-Length it repeats; a body is checked as before', async () => {
        const over = String(10 * 1024 * 1024);
        const policyWith = { methods: ['GET', 'HEAD', 'POST'] };
        // the answer to HEAD, a 204 and a 304 carry the length of the resource they stand for and no body
        const bodiless: [string, number][] = [['HEAD', 200], ['GET', 204], ['GET', 304]];
        for (const [method, status] of bodiless) {
            for (const length of [over, '10', 'x']) {
                const { bridge, records } = bridgeWith(async () => new Response(null, { status, headers: { 'content-length': length } }), policyWith);
                const result = await bridge.handle({ url: 'https://api.example/big', method });
                expect(result, `${method} ${status} ${length}`).toMatchObject({ status, body: new Uint8Array(0) });
                expect(records, `${method} ${status} ${length}`).toEqual([expect.objectContaining({ method, outcome: 'ok', status, bytes: 0 })]);
            }
        }
        // Chromium gives a HEAD response an empty stream, not a null body: the method makes it bodiless all the same
        for (const length of [over, '10']) {
            const empty = streamed([], { headers: { 'content-length': length } });
            const { bridge, records } = bridgeWith(async () => empty.response, policyWith);
            expect(await bridge.handle({ url: 'https://api.example/big', method: 'HEAD' }), length).toMatchObject({ status: 200, body: new Uint8Array(0) });
            expect(empty.state.pulled).toBe(0);
            expect(records, length).toEqual([expect.objectContaining({ method: 'HEAD', outcome: 'ok', bytes: 0 })]);
        }
        // the same declared length on a response that has a body is still refused unread
        for (const method of ['GET', 'POST']) {
            const declared = streamed([10, 10], { headers: { 'content-length': over } });
            const { bridge, records } = bridgeWith(async () => declared.response, policyWith);
            await expect(bridge.handle({ url: 'https://api.example/big', method })).rejects.toMatchObject({ code: 'FETCH_TOO_LARGE' });
            expect(declared.state.pulled, method).toBe(0);
            expect(declared.state.cancelled, method).toBe(true);
            expect(records, method).toEqual([expect.objectContaining({ outcome: 'failed', code: 'FETCH_TOO_LARGE' })]);
        }
        // and a declared length under the cap on a body is read
        const small = streamed([10, 10], { headers: { 'content-length': '20' } });
        expect(await bridgeWith(async () => small.response).bridge.handle({ url: 'https://api.example/small' })).toMatchObject({ status: 200 });
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
        const hanging = bridgeWith((request) => new Promise((_, reject) => request.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))), { timeoutMs: 1000 });
        const pending = hanging.bridge.handle({ url: 'https://api.example/slow' });
        const settled = expect(pending).rejects.toMatchObject({ code: 'FETCH_TIMEOUT' });
        await vi.advanceTimersByTimeAsync(1000);
        await settled;
        expect(hanging.records[0]).toMatchObject({ outcome: 'failed', code: 'FETCH_TIMEOUT' });
    });

    it('caps concurrent requests with FETCH_BUSY, and abortAll() aborts every one in flight and refuses later ones', async () => {
        const { bridge, records, calls } = bridgeWith((request) => new Promise((_, reject) => request.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))), { maxConcurrent: 2 });
        const first = bridge.handle({ url: 'https://api.example/1' });
        const second = bridge.handle({ url: 'https://api.example/2' });
        await expect(bridge.handle({ url: 'https://api.example/3' })).rejects.toMatchObject({ code: 'FETCH_BUSY' });

        bridge.abortAll();
        await expect(first).rejects.toMatchObject({ code: 'FETCH_FAILED' });
        await expect(second).rejects.toMatchObject({ code: 'FETCH_FAILED' });
        await expect(bridge.handle({ url: 'https://api.example/4' })).rejects.toMatchObject({ code: 'FETCH_FAILED' });
        expect(calls.map(c => (c.init.signal as AbortSignal).aborted)).toEqual([true, true]);
        // the one refused after close is 'aborted' too (LM-1, the owner's decision): after its teardown an environment's
        // records are all 'aborted' (test/unit/fetch-bridge-lifecycle.test.ts covers every settle path)
        expect(records.map(r => r.outcome)).toEqual(['refused', 'aborted', 'aborted', 'aborted']);
    });

    it('clamps what the guest supplied before reporting it', async () => {
        const { bridge, records } = bridgeWith(async () => new Response('x'));
        await bridge.handle({ url: 'x'.repeat(10000), method: '<script>' }).catch(() => {});
        await bridge.handle({ url: 'https://other.example/a#secret-fragment', method: 'get' }).catch(() => {});
        expect(records[0]).toMatchObject({ url: 'x'.repeat(8192), method: '' }); // MAX_URL
        expect(records[1]).toMatchObject({ url: 'https://other.example/a', method: 'GET' });
        expect(Object.isFrozen(records[0])).toBe(true);
    });

    it('the codes are the closed set the broker forwards', () => {
        expect(FETCH_ERROR_CODES).toEqual(['FETCH_NOT_ALLOWED', 'FETCH_BUSY', 'FETCH_REDIRECT', 'FETCH_TOO_LARGE', 'FETCH_TIMEOUT', 'FETCH_FAILED']);
    });
});

describe('FetchRecord, a union keyed by outcome (S76, decision D)', () => {
    /** A consumer narrowing on `outcome`: each case reads only the fields its outcome has, and a new outcome fails to compile. */
    const describeRecord = (record: FetchRecord): string => {
        switch (record.outcome) {
            case 'ok': return `${record.status} ${record.bytes}`;
            case 'refused': return `${record.code} ${record.reason ?? 'no reason'}`;
            case 'failed': return `${record.code} ${record.status ?? 'no response'}`;
            case 'aborted': return `${record.code satisfies 'FETCH_FAILED'}`;
            default: return record satisfies never;
        }
    };

    it('the outcomes are the list, and the record of each path narrows on it', async () => {
        expect(FETCH_OUTCOMES).toEqual(['ok', 'refused', 'failed', 'aborted']);
        const records: FetchRecord[] = [];
        const bridge = createFetchBridge({ policy: policy(), hostOrigin: HOST, onRecord: (r) => records.push(r), transport: (async () => new Response('hello', { status: 201 })) as any });
        await bridge.handle({ url: 'https://api.example/ok' });
        await bridge.handle({ url: 'https://other.example/x' }).catch(() => {});
        expect(records.map(describeRecord)).toEqual(['201 5', "FETCH_NOT_ALLOWED no reason"]);
        // the fields an outcome lacks are absent, not undefined
        expect(Object.keys(records[0]!).sort()).toEqual(['bytes', 'durationMs', 'method', 'outcome', 'status', 'url']);
        expect(Object.keys(records[1]!).sort()).toEqual(['bytes', 'code', 'durationMs', 'method', 'outcome', 'url']);
    });

    it('a field an outcome lacks is a type error, and reading it is allowed', () => {
        // @ts-expect-error an ok record has no code
        const withCode: FetchRecord = { method: 'GET', url: 'https://api.example/', durationMs: 1, outcome: 'ok', status: 200, bytes: 0, code: 'FETCH_FAILED' };
        // @ts-expect-error a refused record has no status
        const withStatus: FetchRecord = { method: 'GET', url: 'https://api.example/', durationMs: 1, outcome: 'refused', code: 'FETCH_BUSY', bytes: 0, status: 200 };
        // @ts-expect-error an aborted record's code is FETCH_FAILED
        const otherCode: FetchRecord = { method: 'GET', url: 'https://api.example/', durationMs: 1, outcome: 'aborted', code: 'FETCH_TIMEOUT', bytes: 0 };
        // every member declares every optional field, so a consumer of the plain union reads them without narrowing
        const seen: (number | string | undefined)[] = [withCode.status, withStatus.reason, otherCode.status];
        expect(seen).toHaveLength(3);
    });
});

describe('the method of a request is read once: the record names the method the check judged (BD3:LIM-2, class D)', () => {
    // [what the guest sent as `method` (a request that has the key), the record's method, whether the default policy admits it]
    const METHODS: Array<[string, unknown, string, boolean]> = [
        ['undefined', undefined, 'GET', true],
        ['null', null, '', false],
        ['a number', 7, '', false],
        ['an object', { toString: () => 'GET' }, '', false],
        ['an array', ['GET'], '', false],
        ['text that is no token', 'GE T', '', false],
        ['too long', 'G'.repeat(17), '', false],
        ['a lower-case method', 'post', 'POST', true],
        ['a method the policy refuses', 'delete', 'DELETE', false],
    ];

    it.each(METHODS)('method %s: the record says %j, and the request is made: %s', async (_, method, recorded, admitted) => {
        const records: FetchRecord[] = [];
        const bridge = createFetchBridge({ policy: policy(), hostOrigin: HOST, onRecord: (r) => records.push(r), transport: (async () => new Response('x')) as any });
        const result = await bridge.handle({ url: 'https://api.example/x', method }).then(() => 'made', error => refusalCode(error));
        expect(result).toBe(admitted ? 'made' : 'FETCH_NOT_ALLOWED');
        expect(records).toHaveLength(1);
        expect(records[0]!.method).toBe(recorded);
        // the record's method is the one the check judged: the validated method when there is one
        const checked = validateRequest({ url: 'https://api.example/x', method }, policy(), HOST);
        if (!(checked instanceof Error)) expect(checked.method).toBe(recorded);
    });

    it('an absent method is GET in the check and in the record; a request with no `method` key reads the same as one that is undefined', async () => {
        const records: FetchRecord[] = [];
        const bridge = createFetchBridge({ policy: policy(), hostOrigin: HOST, onRecord: (r) => records.push(r), transport: (async () => new Response('x')) as any });
        await bridge.handle({ url: 'https://api.example/a' });
        await bridge.handle({ url: 'https://api.example/b', method: undefined });
        await bridge.handle('not a request').catch(() => {});
        expect(records.map(r => r.method)).toEqual(['GET', 'GET', 'GET']);
    });
});
