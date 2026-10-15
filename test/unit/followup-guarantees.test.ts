import { describe, it, expect, vi, afterEach } from 'vitest';
import { VIOLATION_DIRECTIVES, VIOLATION_EVENT_LIMIT } from '@src/lib/violation';

/**
 * Follow-up audit 2026-10-14 (docs/security/ADVERSARIAL-REVIEW-2026-10.md, "Follow-up"), host side: the execution
 * budget (backlog B8; since the focused review 2026-10-14, F2: a free event loop at each deadline) and the rule for work handed to a sandbox with no environment (backlog B8), the one place a log detail
 * is made (B3), and the per-directive violation counts of the strict view (C4). The in-browser halves are in
 * test/e2e/worker-timeout.spec.ts and test/e2e/review-strict.spec.ts.
 */

async function mount(config?: Record<string, unknown>, connect = true) {
    const { defineWebSandbox } = await import('@src/host');
    defineWebSandbox();
    const el = document.createElement('web-sandbox') as any;
    if (connect) document.body.appendChild(el);
    if (config) el.setConfig(config);
    return el;
}

// A port the element posts to, recording every frame: the element compares ports by identity only.
const recordingPort = () => {
    const posted: any[] = [];
    return { posted, postMessage: (frame: unknown) => posted.push(frame), close() {} };
};

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    document.body.replaceChildren();
});

describe('B8, focused review F2: workerExecutionTimeout requires a free event loop at each deadline', () => {
    const REASON = 'the executed code ran longer than workerExecutionTimeout';
    const start = async (mode: string, budget: unknown = 50) => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const { EXECUTION_TIMEOUT_GRACE_MS } = await import('@src/host');
        const el = await mount({ mode, scriptUnsafe: true, workerExecutionTimeout: budget });
        const port = recordingPort();
        el._port = port;
        const reasons: string[] = [];
        el.addEventListener('terminated', (e: CustomEvent) => reasons.push(e.detail.reason));
        const logs: string[] = [];
        el.addEventListener('sandbox-log', (e: CustomEvent) => logs.push(e.detail.args[0]));
        vi.useFakeTimers();
        const source = mode === 'strict' ? 'logic' : null;
        const say = (frame: unknown) => el._onGuestMessage(port, () => {}, frame, source);
        const pings = () => port.posted.filter((f: any) => f.type === 'PING').map((f: any) => f.n as number);
        return { el, port, reasons, logs, say, pings, grace: EXECUTION_TIMEOUT_GRACE_MS };
    };

    it.each(['worker', 'strict'])('%s mode: at the deadline the host pings through the bootstrap; an answer (a free event loop) passes: nothing happens and the environment is kept', async (mode) => {
        const { el, port, reasons, logs, say, pings, grace } = await start(mode);
        el.execute('globalThis.x = 1');
        expect(port.posted).toEqual([{ type: 'EXECUTE', code: 'globalThis.x = 1' }]); // nothing to report back: no number
        vi.advanceTimersByTime(49);
        expect(pings()).toEqual([]);
        vi.advanceTimersByTime(1);
        expect(pings()).toEqual([-1]); // a number of its own, never the watchdog's
        say({ type: 'PONG', n: -1 });
        const frame = el.shadowRoot.querySelector('iframe');
        vi.advanceTimersByTime(grace * 3);
        expect([el.state, reasons, logs, pings()]).toEqual(['loading', [], [], [-1]]);
        expect(el.shadowRoot.querySelector('iframe')).toBe(frame);
    });

    it.each(['worker', 'strict'])('%s mode: no answer within the grace ends the sandbox: the host line, then terminated with the reason; pings repeat each tick meanwhile', async (mode) => {
        const { el, reasons, logs, pings, grace } = await start(mode);
        el.execute('for (;;) {}');
        vi.advanceTimersByTime(50 + grace - 1);
        expect(el.state).toBe('loading');
        expect(pings()).toEqual([-1, -2, -3, -4]);
        vi.advanceTimersByTime(1);
        expect([el.state, reasons, logs]).toEqual(['terminated', [REASON], ['Execution Timeout']]);
        expect(el.shadowRoot.querySelector('iframe')).toBeNull();
    });

    it('nothing the guest says ends a budget: the old EXECUTED report, the watchdog\'s numbers, another probe\'s number or a non-number change nothing (A1, A2)', async () => {
        const { el, reasons, say, grace } = await start('worker');
        el.execute('a');
        say({ type: 'EXECUTED', n: 1 });
        vi.advanceTimersByTime(50);
        for (const n of [1, 0, -2, '-1', null]) say({ type: 'PONG', n });
        vi.advanceTimersByTime(grace);
        expect(reasons).toEqual([REASON]);
    });

    it('each execute() has its own deadline, and each deadline checks the one event loop: the first answered, the second not, terminated at the second; an answer to an earlier probe does not pass a later one', async () => {
        const { el, reasons, say, pings, grace } = await start('worker', 100);
        el.execute('a');
        vi.advanceTimersByTime(60);
        el.execute('b');
        vi.advanceTimersByTime(40); // a's deadline
        expect(pings()).toEqual([-1]);
        say({ type: 'PONG', n: -1 });
        vi.advanceTimersByTime(60); // b's deadline
        expect(pings()).toEqual([-1, -2]);
        say({ type: 'PONG', n: -1 }); // a's answer again: proves nothing about now
        vi.advanceTimersByTime(grace);
        expect(reasons).toEqual([REASON]);
    });

    it('a teardown ends every deadline and every probe in flight', async () => {
        const { el, port, reasons, pings, grace } = await start('worker');
        el.execute('a');
        vi.advanceTimersByTime(50); // probing
        el.execute('b');
        el.reset();
        el._port = port;
        vi.advanceTimersByTime(grace * 3);
        expect([el.state, reasons, pings()]).toEqual(['loading', [], [-1]]);
        expect(el._executionProbes.size).toBe(0);
    });

    it('cooperative mode has no budget, and a budget that is not a finite number > 0 is off', async () => {
        for (const [mode, budget] of [['cooperative', 50], ['worker', '50'], ['worker', -1], ['worker', Infinity]] as const) {
            const { el, reasons, pings, grace } = await start(mode, budget);
            el.execute('for (;;) {}');
            vi.advanceTimersByTime(1000 + grace);
            expect([reasons, pings()], `${mode} ${String(budget)}`).toEqual([[], []]);
            vi.useRealTimers();
        }
    });
});

describe('B8: execute() and call() follow one rule while there is no environment', () => {
    it('idle (not in the document): call() rejects at once with TERMINATED, execute() warns and keeps nothing for later (before: the call waited for insertion, the code was dropped there)', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const el = await mount({ scriptUnsafe: true, capabilities: ['allow-scripts'] }, false);
        expect(el.state).toBe('idle');
        let settled: unknown = 'pending';
        el.call('anything').catch((error: any) => { settled = error.code; });
        el.callWithTimeout(10, 'anything').catch(() => {});
        await Promise.resolve();
        await Promise.resolve();
        expect(settled).toBe('TERMINATED');
        el.execute('console.log(1)');
        expect(el._queue).toEqual([]);
        expect(warn.mock.calls.some(c => String(c[0]).includes('execute() ignored: the sandbox is not in the document'))).toBe(true);
    });

    it('terminated: the same refusals (unchanged)', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const el = await mount({ scriptUnsafe: true });
        el.terminate();
        await expect(el.call('x')).rejects.toMatchObject({ code: 'TERMINATED' });
        el.execute('1');
        expect(el._queue).toEqual([]);
        expect(warn.mock.calls.some(c => String(c[0]).includes('execute() ignored: the sandbox was terminated'))).toBe(true);
    });

    it('loading: both are queued for the environment being built (positive control)', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const el = await mount({ scriptUnsafe: true });
        expect(el.state).toBe('loading');
        el.execute('1');
        const pending = el.call('x');
        expect(el._queue.map((item: any) => ('code' in item ? item.code : item.frame.method))).toEqual(['1', 'x']); // one queue, in order (L-3)
        el.reset();
        await expect(pending).rejects.toMatchObject({ code: 'TERMINATED' });
    });

    it('execute() takes a string only', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const el = await mount({ scriptUnsafe: true });
        el.execute(() => 1);
        expect(el._queue).toEqual([]);
        expect(warn.mock.calls.some(c => String(c[0]).includes('code must be a string'))).toBe(true);
    });
});

describe('B3: _dispatchLog makes every detail itself, from the raw line and its source', () => {
    it('no caller can dispatch a detail of its own making', async () => {
        const el = await mount();
        const heard: any[] = [];
        el.addEventListener('sandbox-log', (e: CustomEvent) => heard.push(e.detail));
        el._dispatchLog({ type: 'LOG', level: 'shout', args: 5, source: 'host', extra: true }, 'guest');
        expect(heard).toEqual([{ type: 'LOG', level: 'log', args: [], source: 'guest' }]);
        expect(Object.isFrozen(heard[0])).toBe(true);
    });
});

describe('C4: the view port counts violations per directive; the logic port and cooperative and worker mode keep one count', () => {
    const flood = (el: any, port: unknown, directive: string, count: number, onView: boolean) => {
        for (let i = 0; i < count; i++) {
            const frame = { type: 'VIOLATION', directive, blockedURI: `https://x.test/${directive}/${i}` };
            if (onView) el._onViewMessage(port, frame);
            else el._onGuestMessage(port, () => {}, frame, el._config.mode === 'strict' ? 'logic' : null);
        }
    };
    const counted = (heard: any[]) => {
        const counts: Record<string, number> = {};
        for (const detail of heard) counts[`${detail.source ?? '-'}:${detail.directive}`] = (counts[`${detail.source ?? '-'}:${detail.directive}`] ?? 0) + 1;
        return counts;
    };

    it(`strict view: ${VIOLATION_EVENT_LIMIT + 50} refused images do not hide a later script-src-attr report; each directive warns once at its own cap (before: one shared cap)`, async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const el = await mount({ mode: 'strict' });
        const view = recordingPort();
        el._viewPort = view;
        const heard: any[] = [];
        el.addEventListener('violation', (e: CustomEvent) => heard.push(e.detail));
        flood(el, view, 'img-src', VIOLATION_EVENT_LIMIT + 50, true);
        flood(el, view, 'script-src-attr', 2, true);
        expect(counted(heard)).toEqual({ 'view:img-src': VIOLATION_EVENT_LIMIT, 'view:script-src-attr': 2 });
        expect(warn.mock.calls.filter(c => String(c[0]).includes('CSP violations for img-src on its view port'))).toHaveLength(1);
    });

    it('strict view: the events are bounded however many names arrive: the known directives each, and one bucket for every other name', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const el = await mount({ mode: 'strict' });
        const view = recordingPort();
        el._viewPort = view;
        let events = 0;
        el.addEventListener('violation', () => events++);
        for (const directive of VIOLATION_DIRECTIVES) flood(el, view, directive, VIOLATION_EVENT_LIMIT + 1, true);
        for (let i = 0; i < 300; i++) flood(el, view, `x-made-up-${String.fromCharCode(97 + (i % 26))}${i}`.replace(/\d/g, 'z'), 2, true);
        expect(events).toBe((VIOLATION_DIRECTIVES.length + 1) * VIOLATION_EVENT_LIMIT);
    });

    it.each([['strict', 'logic'], ['cooperative', 'guest'], ['worker', 'guest']])('%s mode, %s port: one count for every directive (guest code names them there)', async (mode, _port) => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const el = await mount({ mode });
        const port = recordingPort();
        el._port = port;
        let events = 0;
        el.addEventListener('violation', () => events++);
        flood(el, port, 'img-src', VIOLATION_EVENT_LIMIT, false);
        flood(el, port, 'script-src-attr', 5, false);
        expect(events).toBe(VIOLATION_EVENT_LIMIT);
    });
});
