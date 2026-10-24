import { afterEach, describe, expect, it, vi } from 'vitest';
import { defineWebSandbox } from '@src/host';

/**
 * The wrapper's load completes a build only for a frame that is still the element's (BD2:TST-7, class L; R4:L-1). The
 * check is made in the microtask the load handler queues (`stillOurs`, src/host.ts `_frameLoadHandler`): the same frame
 * as the element's, and both connected. The reducer tests (lifecycle-reducer.test.ts) feed `stillOurs` by hand and
 * check-in.ts plays it as `true`; this drives the real handler, so a handler that always said `true` is caught: the load
 * of a frame other than the element's would end the build, for a frame with no window, as `frameMissing`.
 */
defineWebSandbox();

afterEach(() => {
    vi.restoreAllMocks();
    document.body.replaceChildren();
});

const flush = () => new Promise<void>(resolve => queueMicrotask(() => queueMicrotask(resolve)));

function built() {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const el = document.createElement('web-sandbox') as any;
    document.body.appendChild(el);
    el.setConfig({ mode: 'cooperative', capabilities: [], html: '<p>x</p>' });
    const terminated: string[] = [];
    el.addEventListener('terminated', (event: Event) => terminated.push((event as CustomEvent).detail.reason));
    return { el, terminated, frame: el._iframe as HTMLIFrameElement };
}

describe('the load of a frame that is not the element\'s is dropped (the real handler, in its microtask)', () => {
    it('a frame other than the element\'s', async () => {
        const { el, terminated } = built();
        expect(el.state).toBe('loading');
        const other = document.createElement('iframe');
        document.body.appendChild(other);
        el._frameLoadHandler(other)();
        await flush();
        expect([el.state, terminated]).toEqual(['loading', []]);
    });

    it('the element\'s own frame, taken out of the page', async () => {
        const { el, terminated, frame } = built();
        const handler = el._frameLoadHandler(frame);
        frame.remove();
        handler();
        await flush();
        expect([el.state, terminated]).toEqual(['loading', []]);
    });
});
