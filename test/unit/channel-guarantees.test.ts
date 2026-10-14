import { describe, it, expect, vi, afterEach } from 'vitest';
import { LOG_EVENTS_PER_SECOND, LOG_MAX_ARGS, LOG_MAX_STRING, toLogDetail } from '@src/lib/sandbox-log';
import { SandboxDevTools } from '@src/devtools';
import { createFetchBridge, toFetchPolicy, validateRequest } from '@src/lib/fetch-bridge';

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
        el._startTimeout();
        vi.advanceTimersByTime(20);
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
        expect(heard.filter(d => d.source === 'host')).toHaveLength(1);
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
    it('the execution timeout: a sandbox-log listener that terminates leaves it terminated (no rebuild)', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const el = await mount({ mode: 'worker', scriptUnsafe: true, workerExecutionTimeout: 10 });
        el.addEventListener('sandbox-log', (e: CustomEvent) => { if (e.detail.source === 'host') el.terminate('stopped by a listener'); });
        vi.useFakeTimers();
        el._startTimeout();
        vi.advanceTimersByTime(20);
        expect(el.state).toBe('terminated');
        expect(el.shadowRoot.querySelector('iframe')).toBeNull();
    });

    it('an entry that failed to start: a sandbox-log listener that resets gets the new environment, not a termination', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const el = await mount({ mode: 'strict' });
        const { port1: view } = new MessageChannel();
        el._viewPort = view;
        const terminations: string[] = [];
        el.addEventListener('terminated', (e: CustomEvent) => terminations.push(e.detail.reason));
        el.addEventListener('sandbox-log', (e: CustomEvent) => { if (e.detail.source === 'host') el.reset(); }, { once: true });
        el._onViewMessage(view, { type: 'GUEST_ERROR', message: 'SyntaxError' });
        expect([el.state, terminations]).toEqual(['loading', []]);
        expect(el.shadowRoot.querySelector('iframe')).not.toBeNull();
        view.close();
    });

    it('without a listener both still end as before (positive control)', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const el = await mount({ mode: 'strict' });
        const { port1: view } = new MessageChannel();
        el._viewPort = view;
        el._onViewMessage(view, { type: 'GUEST_ERROR', message: 'SyntaxError' });
        expect(el.state).toBe('terminated');
        view.close();
    });
});

describe('B6: a fetch header value must be a ByteString without CR, LF or NUL', () => {
    const policy = toFetchPolicy({ allow: ['https://api.example'] }, () => {})!;

    it.each(['Ā', '😀', 'a b', 'a\rb', 'a\nb', 'a\u0000b'])('%j is refused before any request (FETCH_NOT_ALLOWED)', (value) => {
        const result = validateRequest({ url: 'https://api.example/x', headers: [['accept', value]] }, policy, 'https://host.example');
        expect(result).toBeInstanceOf(Error);
        expect((result as any).code).toBe('FETCH_NOT_ALLOWED');
    });

    it.each(['text/html', 'é', 'a\tb', 'ÿ'])('%j is accepted', (value) => {
        expect(validateRequest({ url: 'https://api.example/x', headers: [['accept', value]] }, policy, 'https://host.example')).not.toBeInstanceOf(Error);
    });

    it("the record says 'refused', not 'failed', and fetch is never called", async () => {
        const records: any[] = [];
        const fetchImpl = vi.fn(async () => new Response('x'));
        const bridge = createFetchBridge({ policy, hostOrigin: 'https://host.example', onRecord: (r) => records.push(r), fetchImpl: fetchImpl as any });
        await expect(bridge.handle({ url: 'https://api.example/x', headers: [['accept', 'Ā']] })).rejects.toMatchObject({ code: 'FETCH_NOT_ALLOWED' });
        expect(fetchImpl).not.toHaveBeenCalled();
        expect(records.map(r => [r.outcome, r.code])).toEqual([['refused', 'FETCH_NOT_ALLOWED']]);
    });
});
