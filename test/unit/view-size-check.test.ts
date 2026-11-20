import '@src/network'; // the network build: this file tests strict mode beside sealed mode (ADR-009)
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startWith } from './start-app';

/**
 * The view's size at its check-in (R1:R3-1). A view 150 px high in a taller frame means the host page's style-src
 * refused the wrapper's style, where the element wrote the wrapper (strict mode): it warns. Sealed mode's view is the
 * served file, whose sizing sheet its own policy admits, and whose frame's size can reach the view after its check-in
 * (Firefox, in the directive matrix on a loaded machine: the warning with a view that then filled its frame). Its size
 * at check-in is not judged.
 */

afterEach(() => {
    vi.restoreAllMocks();
    document.body.replaceChildren();
});

async function checkedIn(mode: 'strict' | 'sealed', height: number) {
    const { defineWebSandbox } = await import('@src/host');
    defineWebSandbox({ documentUrl: '/sealed-document.html' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const el = document.createElement('web-sandbox') as any;
    document.body.appendChild(el);
    startWith(el, { mode });
    Object.defineProperty(el._iframe, 'clientHeight', { configurable: true, value: 300 });
    el._setupChannel(new MessageChannel().port1);
    el._step({ t: 'viewReady', gen: el._lc.gen, height, stillStyleRefused: false });
    const sized = warn.mock.calls.map(call => String(call[0])).filter(message => /px high in a frame of/.test(message));
    return { state: el.state as string, sized };
}

describe("the view's size at its check-in", () => {
    it("strict mode: 150 px in a 300 px frame is the wrapper's style refused, and the element says so once", async () => {
        const { state, sized } = await checkedIn('strict', 150);
        expect(state).toBe('ready');
        expect(sized).toHaveLength(1);
        expect(sized[0]).toContain("the host page's style-src refuses the wrapper's style");
    });

    it('sealed mode: the same check-in warns nothing, since the served file is not the wrapper and its size may not have arrived', async () => {
        const { state, sized } = await checkedIn('sealed', 150);
        expect(state).toBe('ready');
        expect(sized).toEqual([]);
    });

    it('a view that fills its frame warns nothing in either mode', async () => {
        for (const mode of ['strict', 'sealed'] as const) expect((await checkedIn(mode, 300)).sized, mode).toEqual([]);
    });
});
