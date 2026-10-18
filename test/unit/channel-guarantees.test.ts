import { EXECUTION_TIMEOUT_GRACE_MS } from '@src/host';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { LOG_EVENTS_PER_SECOND, LOG_MAX_ARGS, LOG_MAX_STRING, toLogDetail } from '@src/lib/sandbox-log';
import { SandboxDevTools } from '@src/devtools';
import { createFetchBridge, toFetchPolicy } from '@src/lib/fetch-bridge';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Adversarial review 2026-10, channels and lifecycle (docs/security/ADVERSARIAL-REVIEW-2026-10.md), host side:
 * B3 log lines, B4 frames from a port that is no longer current, B5 a listener's reset() or terminate() is never
 * undone, B6 fetch header values. The in-browser halves are in test/e2e/review-channels.spec.ts.
 */

async function mount(config?: Record<string, unknown>) {
    const { defineWebSandbox } = await import('@src/host');
    defineWebSandbox();
    const el = document.createElement('web-sandbox') as any;
    document.body.appendChild(el);
    if (config) el.setConfig(config);
    return el;
}

const logs = (el: HTMLElement) => {
    const heard: any[] = [];
    el.addEventListener('sandbox-log', (e) => heard.push((e as CustomEvent).detail));
    return heard;
};

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    document.body.replaceChildren();
});

describe('B3: every sandbox-log detail is normalised and labelled', () => {
    it.each([
        [{ type: 'LOG', level: 1, args: [] }, { level: 'log', args: [] }],
        [{ type: 'LOG', level: 'log', args: 5 }, { level: 'log', args: [] }],
        [{ type: 'LOG', level: 'x%c%c%s', args: ['%chi', 'color:red'] }, { level: 'log', args: ['%chi', 'color:red'] }],
        [{ type: 'LOG', level: 'warn', args: ['a'], source: 'host', extra: 1 }, { level: 'warn', args: ['a'] }],
        [null, { level: 'log', args: [] }],
    ])('%j', (frame, expected) => {
        const detail = toLogDetail(frame, 'guest');
        expect(detail).toEqual({ type: 'LOG', ...expected, source: 'guest' });
        expect(Object.isFrozen(detail) && Object.isFrozen(detail.args)).toBe(true);
    });

    it(`keeps at most ${LOG_MAX_ARGS} arguments and cuts strings at ${LOG_MAX_STRING} characters; other values pass as cloned`, () => {
        const detail = toLogDetail({ level: 'info', args: [...new Array(200).fill('a'), 'never'] }, 'guest');
        expect(detail.args).toHaveLength(LOG_MAX_ARGS);
        const long = toLogDetail({ level: 'info', args: ['y'.repeat(LOG_MAX_STRING + 10), { a: 1 }, 7] }, 'guest');
        expect([(long.args[0] as string).length, long.args[1], long.args[2]]).toEqual([LOG_MAX_STRING, { a: 1 }, 7]);
    });

    it("the element labels guest lines 'guest' and its own lines 'host', whatever a frame claims", async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const el = await mount({ mode: 'worker', scriptUnsafe: true, workerExecutionTimeout: 10 });
        const heard = logs(el);
        el._onGuestMessage(el._port, () => {}, { type: 'LOG', level: 'error', args: ['Execution Timeout'], source: 'host' }, null);
        expect(heard).toEqual([]); // no port in jsdom: nothing is current, nothing is heard (B4)
        const { port1 } = new MessageChannel();
        el._port = port1;
        el._onGuestMessage(port1, () => {}, { type: 'LOG', level: 'error', args: ['Execution Timeout'], source: 'host' }, null);
        vi.useFakeTimers();
        el.execute('for (;;) {}'); // nobody answers the probe at the deadline here: its budget expires
        vi.advanceTimersByTime(20 + EXECUTION_TIMEOUT_GRACE_MS);
        expect(heard.map(d => [d.source, d.args[0]])).toEqual([['guest', 'Execution Timeout'], ['host', 'Execution Timeout']]);
        port1.close();
    });

    it(`dispatches at most ${LOG_EVENTS_PER_SECOND} guest lines per second per environment, with one warning; host lines are never limited; a new environment starts afresh`, async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const el = await mount();
        const heard = logs(el);
        const { port1 } = new MessageChannel();
        el._port = port1;
        for (let i = 0; i < LOG_EVENTS_PER_SECOND + 500; i++) el._onGuestMessage(port1, () => {}, { type: 'LOG', level: 'log', args: [i] }, null);
        el._dispatchHostLog('error', 'a line of the host');
        expect(heard.filter(d => d.source === 'guest')).toHaveLength(LOG_EVENTS_PER_SECOND);
        // the host's own lines: the one notice that guest lines were dropped (review round 3, L-4), and the line above
        expect(heard.filter(d => d.source === 'host').map(d => [d.level, d.args[0]])).toEqual([['warn', expect.stringContaining('lines in one second')], ['error', 'a line of the host']]);
        expect(warn.mock.calls.filter(c => String(c[0]).includes('lines in one second'))).toHaveLength(1);

        el.reset();
        const { port1: next } = new MessageChannel();
        el._port = next;
        el._onGuestMessage(next, () => {}, { type: 'LOG', level: 'log', args: ['after reset'] }, null);
        expect(heard.at(-1)!.args).toEqual(['after reset']);
        port1.close();
        next.close();
    });

    it('SandboxDevTools never throws on any detail, and never passes a guest value as the console format string', () => {
        const group = vi.spyOn(console, 'groupCollapsed').mockImplementation(() => {});
        const log = vi.spyOn(console, 'log').mockImplementation(() => {});
        vi.spyOn(console, 'groupEnd').mockImplementation(() => {});
        vi.spyOn(console, 'info').mockImplementation(() => {});
        const target = document.createElement('div');
        const tools = new SandboxDevTools(target);
        tools.activate();
        for (const detail of [{ type: 'LOG', level: 1, args: [] }, { type: 'LOG', level: 'log', args: 5 }, { type: 'LOG', level: 'x', args: ['%chi', 'color:red'] }, null, 7, { type: 'LOG', get level() { throw new Error('no'); } }]) {
            expect(() => target.dispatchEvent(new CustomEvent('sandbox-log', { detail }))).not.toThrow();
        }
        expect(group).toHaveBeenCalled();
        for (const call of log.mock.calls) expect(String(call[0])).not.toContain('%chi');
    });
});

describe('B4: only the current environment\'s ports are heard', () => {
    it('a frame from a port of an earlier environment dispatches nothing and changes no state; the current port is heard (positive control)', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const el = await mount({ mode: 'strict' });
        const { port1: oldPort } = new MessageChannel();
        const { port1: oldView } = new MessageChannel();
        el._port = oldPort;
        el._viewPort = oldView;
        el.reset(); // the environment those ports belonged to is gone
        const { port1: current } = new MessageChannel();
        el._port = current;
        const heard: string[] = [];
        for (const type of ['sandbox-log', 'violation', 'terminated']) el.addEventListener(type, () => heard.push(type));
        const reply = vi.fn();

        el._onGuestMessage(oldPort, reply, { type: 'LOG', level: 'log', args: ['stale'] }, 'logic');
        el._onGuestMessage(oldPort, reply, { type: 'VIOLATION', directive: 'img-src', blockedURI: 'stale' }, 'logic');
        el._onGuestMessage(oldPort, reply, { type: 'RPC_REQ', id: 1, method: 'anything', args: [] }, 'logic');
        el._onViewMessage(oldView, { type: 'GUEST_ERROR', message: 'stale' });
        await new Promise(resolve => setTimeout(resolve, 0));
        expect([heard, reply.mock.calls.length, el.state]).toEqual([[], 0, 'loading']);

        el._onGuestMessage(current, reply, { type: 'VIOLATION', directive: 'img-src', blockedURI: 'current' }, 'logic');
        expect(heard).toEqual(['violation']);
        for (const port of [oldPort, oldView, current]) port.close();
    });
});

describe('B5: a listener that resets or terminates the sandbox is never undone', () => {
    // Every host path that dispatches an event and then acts on the environment, each forced here. They all go
    // through one helper (_notifyThenAct); the source check below fails when a path is added without it, or
    // without a row here.
    const PATHS: { name: string; reason: string; start: () => Promise<{ el: any; force: () => void; done: () => void }> }[] = [
        {
            name: 'the execution timeout (worker mode)',
            reason: 'the executed code ran longer than workerExecutionTimeout',
            start: async () => {
                const el = await mount({ mode: 'worker', scriptUnsafe: true, workerExecutionTimeout: 10 });
                const { port1 } = new MessageChannel();
                el._port = port1;
                vi.useFakeTimers();
                // the deadline, then a grace without an answer
                return { el, force: () => { el.execute('for (;;) {}'); vi.advanceTimersByTime(20 + EXECUTION_TIMEOUT_GRACE_MS); }, done: () => port1.close() };
            },
        },
        {
            name: 'an entry that failed to start (strict mode)',
            reason: 'the guest entry failed to start',
            start: async () => {
                const el = await mount({ mode: 'strict' });
                const { port1: view } = new MessageChannel();
                el._viewPort = view;
                return { el, force: () => el._onViewMessage(view, { type: 'GUEST_ERROR', message: 'SyntaxError' }), done: () => view.close() };
            },
        },
        {
            name: "a worker the host page's policy refused (strict mode, review round 1 R3-1)",
            reason: "the sandbox's worker could not be loaded: the host page's policy refuses blob: workers (worker-src; WebKit also under Cross-Origin-Embedder-Policy; see docs/API.md#host-page-policy)",
            start: async () => {
                const el = await mount({ mode: 'strict' });
                const { port1: view } = new MessageChannel();
                el._viewPort = view;
                return { el, force: () => el._onViewMessage(view, { type: 'WORKER_REFUSED' }), done: () => view.close() };
            },
        },
    ];

    describe.each(PATHS)('$name', ({ reason, start }) => {
        const run = async (listener: ((el: any) => void) | null) => {
            vi.spyOn(console, 'warn').mockImplementation(() => {});
            const { el, force, done } = await start();
            const terminations: string[] = [];
            el.addEventListener('terminated', (e: CustomEvent) => terminations.push(e.detail.reason));
            if (listener) el.addEventListener('sandbox-log', (e: CustomEvent) => { if (e.detail.source === 'host') listener(el); }, { once: true });
            force();
            const result = { state: el.state, terminations, frame: el.shadowRoot.querySelector('iframe') !== null };
            done();
            return result;
        };

        it('without a listener, the host acts: terminated with its reason (positive control)', async () => {
            expect(await run(null)).toEqual({ state: 'terminated', terminations: [reason], frame: false });
        });

        it("a listener's terminate() stands: one termination, the listener's", async () => {
            expect(await run(el => el.terminate('stopped by a listener'))).toEqual({ state: 'terminated', terminations: ['stopped by a listener'], frame: false });
        });

        it("a listener's reset() stands: the new environment is not torn down", async () => {
            expect(await run(el => el.reset())).toEqual({ state: 'loading', terminations: [], frame: true });
        });
    });

    it('the source: _generation is compared only inside _notifyThenAct (and, for a call, _issue and _postRpc), and every call of _notifyThenAct is a row of PATHS', () => {
        const source = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../../src/host.ts'), 'utf8');
        const bodyOf = (name: string) => {
            const start = source.indexOf(`private ${name}(`);
            return [start, source.indexOf('\n    }\n', start)] as const;
        };
        const reads = [...source.matchAll(/this\._generation(?!\+\+)/g)].map(match => match.index!);
        // `const generation = this._generation` and the comparison after notify(); the environment a host call is made
        // in, and the one check that its frame is sent there (review round 3, L-2)
        const READERS: [string, number][] = [['_notifyThenAct', 2], ['_issue', 1], ['_postRpc', 1]];
        expect(reads).toHaveLength(4);
        for (const [name, count] of READERS) {
            const [start, end] = bodyOf(name);
            expect(reads.filter(index => index > start && index < end), name).toHaveLength(count);
        }
        // Paths whose action is not a termination are forced where their feature is tested: the guest-write announcement
        // ('fileswritten', then the acknowledgement; test/unit/guest-writes.test.ts, "review B5").
        const OTHER_PATHS = ['_handleGuestWrite'];
        for (const name of OTHER_PATHS) expect(source.slice(source.indexOf(`private ${name}(`)).indexOf('this._notifyThenAct(')).toBeLessThan(2000);
        expect([...source.matchAll(/this\._notifyThenAct\(/g)]).toHaveLength(PATHS.length + OTHER_PATHS.length);
    });
});

describe('B6: the platform validates a request before the bridge records it (follow-up audit 2026-10-14)', () => {
    const policy = toFetchPolicy({ allow: ['https://api.example'] }, () => {})!;
    const bridgeWith = () => {
        const records: any[] = [];
        const fetchImpl = vi.fn(async (_request: Request) => new Response('x'));
        const bridge = createFetchBridge({ policy, hostOrigin: 'https://host.example', onRecord: (r) => records.push(r), fetchImpl: fetchImpl as any });
        return { bridge, records, fetchImpl };
    };

    // A header value the Fetch standard refuses (not a ByteString, or NUL, CR or LF inside): refused before any
    // request, never reported as made. A regex of the bridge's own used to decide this; now the Request
    // constructor does, so the bridge cannot disagree with the browser.
    it.each(['Ā', '\u{1F600}', 'a b', 'a\rb', 'a\nb', 'a\u0000b'])("%j: the record says 'refused' (FETCH_NOT_ALLOWED), and fetch is never called", async (value) => {
        const { bridge, records, fetchImpl } = bridgeWith();
        await expect(bridge.handle({ url: 'https://api.example/x', headers: [['accept', value]] })).rejects.toMatchObject({ code: 'FETCH_NOT_ALLOWED' });
        expect(fetchImpl).not.toHaveBeenCalled();
        expect(records.map(r => [r.outcome, r.code])).toEqual([['refused', 'FETCH_NOT_ALLOWED']]);
    });

    it.each(['text/html', 'é', 'a\tb', 'ÿ'])('%j is accepted and sent as given', async (value) => {
        const { bridge, fetchImpl } = bridgeWith();
        await bridge.handle({ url: 'https://api.example/x', headers: [['accept', value]] });
        expect(fetchImpl.mock.calls[0]![0].headers.get('accept')).toBe(value);
    });

    it("a body the Request constructor refuses (a view of a SharedArrayBuffer) is 'refused', not reported as 'failed'", async () => {
        const { bridge, records, fetchImpl } = bridgeWith();
        const shared = new Uint8Array(new SharedArrayBuffer(4));
        await expect(bridge.handle({ url: 'https://api.example/x', method: 'POST', body: shared })).rejects.toMatchObject({ code: 'FETCH_NOT_ALLOWED' });
        expect(fetchImpl).not.toHaveBeenCalled();
        expect(records.map(r => [r.outcome, r.code])).toEqual([['refused', 'FETCH_NOT_ALLOWED']]);
    });

    it('fetch() is given the one Request the bridge built and checked, pinned to the bridge discipline: what was validated is what is sent', async () => {
        const { bridge, fetchImpl } = bridgeWith();
        await bridge.handle({ url: 'https://api.example/x#f', method: 'POST', headers: [['content-type', 'text/plain']], body: 'hi', credentials: 'include', mode: 'no-cors' });
        expect(fetchImpl.mock.calls).toHaveLength(1);
        const request = fetchImpl.mock.calls[0]![0];
        // beside it the same pinned init, whole (a partial one would reset the referrer policy)
        expect((fetchImpl.mock.calls[0] as unknown[])[1]).toMatchObject({ credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'manual', mode: 'cors', cache: 'no-store', keepalive: false });
        expect(request).toBeInstanceOf(Request);
        expect([request.url, request.method, request.credentials, request.redirect, request.mode, request.cache]).toEqual(['https://api.example/x', 'POST', 'omit', 'manual', 'cors', 'no-store']);
        expect(await request.text()).toBe('hi');
    });
});
