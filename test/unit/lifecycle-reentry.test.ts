import { afterEach, describe, expect, it, vi } from 'vitest';
import { defineWebSandbox, LOAD_TIMEOUT_MS } from '@src/host';
import { checkIn } from './check-in';

/**
 * LM-2 (class L; S65): embedder code that runs inside the element's own build. A page that patched console.warn runs
 * at each warning, and any setter the page wrapped (the srcdoc setter, where an engine runs a Trusted Types default
 * policy for a string) runs at each assignment; either can call reset(), which builds again from inside the build. The nested build stood, and the outer one then went on over it, with the element's fields:
 * - a second load deadline, which overwrote the nested one's; the nested deadline was never stopped, and LOAD_TIMEOUT_MS
 *   later it ended the sandbox, `ready` as it was;
 * - its announcement listener, on the nested frame, which overwrote the nested one's stop: one listener on the host's
 *   window outlived its environment;
 * - a second appendChild of the nested frame;
 * - and, had the outer build then thrown, its failure ended the nested build.
 * The e2e half (Chromium, WebKit): test/e2e/host-policy.spec.ts, "LM-2": the library's own sinks never ask a real default
 * policy, so none of its code runs there.
 *
 * Here the embedder's code is played by the srcdoc setter itself (the assignment).
 */

defineWebSandbox();

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    document.body.replaceChildren();
});

const COOPERATIVE = { mode: 'cooperative', capabilities: ['allow-scripts'], html: '<p>x</p>' };

function mount() {
    const el = document.createElement('web-sandbox') as any;
    document.body.appendChild(el);
    return el;
}

// The next srcdoc assignment runs `inside` first, once, as a host page's default policy would (createHTML runs inside
// the assignment, before the value is set).
function onNextSrcdoc(inside: () => void) {
    const descriptor = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'srcdoc')!;
    let armed = true;
    vi.spyOn(HTMLIFrameElement.prototype, 'srcdoc', 'set').mockImplementation(function (this: HTMLIFrameElement, value: string) {
        if (armed) {
            armed = false;
            inside();
        }
        descriptor.set!.call(this, value);
    });
}

const terminations = (el: HTMLElement) => {
    const heard: string[] = [];
    el.addEventListener('terminated', (event) => heard.push((event as CustomEvent).detail.reason));
    return heard;
};

describe('LM-2: a build re-entered from inside the build leaves one build, the nested one, with its own resources', () => {
    it('one load deadline: the build is ready and still ready past LOAD_TIMEOUT_MS (before: the stray deadline ended it)', () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const el = mount();
        vi.useFakeTimers();
        const heard = terminations(el);
        onNextSrcdoc(() => el.reset());
        el.setConfig(COOPERATIVE);
        expect(el.state).toBe('loading');
        const { port1 } = new MessageChannel();
        checkIn(el, port1); // the guest's check-in: ready, and the build's deadline stops
        expect(el.state).toBe('ready');
        vi.advanceTimersByTime(LOAD_TIMEOUT_MS * 2);
        expect([el.state, heard]).toEqual(['ready', []]);
        port1.close();
    });

    it("one frame, appended once; one announcement listener on the host's window, removed by the teardown (before: two, one of them leaked)", () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const el = mount();
        const listening = new Set<unknown>();
        const add = window.addEventListener.bind(window);
        const remove = window.removeEventListener.bind(window);
        vi.spyOn(window, 'addEventListener').mockImplementation((type: string, listener: any, options?: any) => {
            if (type === 'message' && options === true) listening.add(listener);
            add(type, listener, options);
        });
        vi.spyOn(window, 'removeEventListener').mockImplementation((type: string, listener: any, options?: any) => {
            if (type === 'message' && options === true) listening.delete(listener);
            remove(type, listener, options);
        });
        const appended: unknown[] = [];
        const append = el.shadowRoot.appendChild.bind(el.shadowRoot);
        vi.spyOn(el.shadowRoot, 'appendChild').mockImplementation((node: any) => {
            appended.push(node);
            return append(node);
        });
        onNextSrcdoc(() => el.reset());
        el.setConfig(COOPERATIVE);
        expect(listening.size).toBe(1);
        const frames = [...el.shadowRoot.querySelectorAll('iframe')];
        expect(frames).toHaveLength(1);
        expect(appended).toEqual(frames);
        el.remove();
        expect(listening.size).toBe(0);
    });

    it("the outer build's failure, after the nested build stood, is not the sandbox's: the nested build stays (before: it ended it)", async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const el = mount();
        const heard = terminations(el);
        onNextSrcdoc(() => {
            el.reset();
            throw new Error('the policy failed after the reset');
        });
        el.setConfig(COOPERATIVE);
        await new Promise(resolve => setTimeout(resolve, 0)); // a build's 'terminated' comes in a task
        expect([el.state, heard, el.shadowRoot.querySelectorAll('iframe').length]).toEqual(['loading', [], 1]);
    });

    it('a warning hook that resets during a termination: the reset stands, with its frame, and nothing more of the termination runs', () => {
        const el = mount();
        el.setConfig(COOPERATIVE);
        const heard = terminations(el);
        let resets = 0;
        vi.spyOn(console, 'warn').mockImplementation((message: unknown) => {
            if (resets === 0 && String(message).startsWith('[Sandbox] terminated:')) {
                resets++;
                el.reset();
            }
        });
        el.terminate('bye');
        expect(resets).toBe(1);
        expect([el.state, heard, el.shadowRoot.querySelectorAll('iframe').length]).toEqual(['loading', [], 1]);
    });
});
