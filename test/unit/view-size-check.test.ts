import '@src/network'; // the network build: this file tests strict mode beside sealed mode (ADR-009)
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startWith } from './start-app';

/**
 * The wrapper-style warning at the view's check-in (R1:R3-1). Where the element wrote the wrapper (strict mode), a view
 * that found the policies it inherits refuse the wrapper's style (`wrapperStyleRefused`, in-sandbox-view.ts,
 * wrapperStyleInForce) is 150 px high in a taller frame, and the element says so once. Its size at the check-in is no
 * evidence: the frame's size can reach the view after it (Firefox, in the directive matrix: the warning with a view that
 * then filled its frame), so a check-in of 150 px whose view found no refusal warns nothing. Sealed mode's view is the
 * served file, whose sizing sheet its own policy admits: nothing is judged there.
 */

afterEach(() => {
    vi.restoreAllMocks();
    document.body.replaceChildren();
});

async function checkedIn(mode: 'strict' | 'sealed', height: number, wrapperStyleRefused: boolean) {
    const { defineWebSandbox } = await import('@src/host');
    defineWebSandbox({ documentUrl: '/sealed-document.html' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const el = document.createElement('web-sandbox') as any;
    document.body.appendChild(el);
    startWith(el, { mode });
    Object.defineProperty(el._iframe, 'clientHeight', { configurable: true, value: 300 });
    el._setupChannel(new MessageChannel().port1);
    el._step({ t: 'viewReady', gen: el._lc.gen, height, stillStyleRefused: false, wrapperStyleRefused });
    el._step({ t: 'workerVerdicts', gen: el._lc.gen, finding: null }); // the worker's verdicts, which complete the build with the check-in
    const sized = warn.mock.calls.map(call => String(call[0])).filter(message => /px high in a frame of/.test(message));
    return { state: el.state as string, sized };
}

describe("the view's size at its check-in", () => {
    it("strict mode: a view that found the wrapper's style refused, 150 px in a 300 px frame, makes the element say so once", async () => {
        const { state, sized } = await checkedIn('strict', 150, true);
        expect(state).toBe('ready');
        expect(sized).toHaveLength(1);
        expect(sized[0]).toContain("the host page's style-src refuses the wrapper's style");
    });

    it("strict mode: a check-in of 150 px in a 300 px frame whose view found no refusal (the frame's size had not reached it yet) warns nothing", async () => {
        const { state, sized } = await checkedIn('strict', 150, false);
        expect(state).toBe('ready');
        expect(sized).toEqual([]);
    });

    it('sealed mode: the same check-in warns nothing, since the served file is not the wrapper and its size may not have arrived', async () => {
        for (const refused of [false, true]) {
            const { state, sized } = await checkedIn('sealed', 150, refused);
            expect(state).toBe('ready');
            expect(sized).toEqual([]);
        }
    });

    it('a view that fills its frame warns nothing in either mode', async () => {
        for (const mode of ['strict', 'sealed'] as const) expect((await checkedIn(mode, 300, false)).sized, mode).toEqual([]);
    });
});
