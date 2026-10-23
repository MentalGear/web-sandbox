import { describe, it, expect, vi, afterEach } from 'vitest';
import { reasonText } from '@src/lib/reasons';

/**
 * The element applies the host page's Trusted Types directives where the browser has none (host.ts, `_trustedTypes`; the
 * grammar is test/unit/host-trusted-types.test.ts's, and the three engines' agreement test/e2e/trusted-types-uniform.spec.ts).
 * jsdom has no `trustedTypes`, so it stands for such a browser: the policy text the embedder passes ends the build with the
 * Trusted Types reason in every mode, refuses `execute()`, and is not asked where the browser has Trusted Types.
 */

const REQUIRING_OTHER = "require-trusted-types-for 'script'; trusted-types other";
const NAMING_IT = "require-trusted-types-for 'script'; trusted-types web-sandbox";

async function mount(config: Record<string, unknown>) {
    const { defineWebSandbox } = await import('@src/host');
    defineWebSandbox();
    const el = document.createElement('web-sandbox') as any;
    const reasons: string[] = [];
    el.addEventListener('terminated', (event: CustomEvent) => reasons.push(event.detail?.reason));
    document.body.appendChild(el);
    el.setConfig(config);
    return { el, reasons };
}

afterEach(() => {
    vi.restoreAllMocks();
    delete (globalThis as any).trustedTypes;
    document.body.replaceChildren();
});

describe('a browser without Trusted Types, given the page\'s policy', () => {
    it.each(['strict', 'cooperative', 'worker'] as const)('%s: a list that does not name the library\'s policy ends the build with the Trusted Types reason', async (mode) => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const { el, reasons } = await mount({ mode, capabilities: mode === 'cooperative' ? ['allow-scripts'] : [], hostContentSecurityPolicy: REQUIRING_OTHER });
        expect(el.state).toBe('terminated');
        await vi.waitFor(() => expect(reasons).toEqual([reasonText('trustedTypes')]));
    });

    it('a list that names it, no requirement, and false end nothing', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        for (const hostContentSecurityPolicy of [NAMING_IT, 'trusted-types other', false, undefined]) {
            const { el, reasons } = await mount({ mode: 'cooperative', capabilities: ['allow-scripts'], hostContentSecurityPolicy });
            expect(el.state, String(hostContentSecurityPolicy)).not.toBe('terminated');
            expect(reasons, String(hostContentSecurityPolicy)).toEqual([]);
            document.body.replaceChildren();
        }
    });

    it('execute() is refused under the requirement with one warning and posts nothing; it is posted without it', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const postMessage = vi.fn();
        const port = { postMessage } as unknown as MessagePort;
        const { el } = await mount({ mode: 'cooperative', capabilities: ['allow-scripts'], scriptUnsafe: true, hostContentSecurityPolicy: NAMING_IT });
        warn.mockClear();
        el._postExecute(port, '1');
        expect(postMessage).not.toHaveBeenCalled();
        expect(warn.mock.calls.map(call => String(call[0])).filter(text => text.startsWith('[Sandbox] execute() refused'))).toHaveLength(1);

        document.body.replaceChildren();
        const free = await mount({ mode: 'cooperative', capabilities: ['allow-scripts'], scriptUnsafe: true, hostContentSecurityPolicy: 'trusted-types web-sandbox' });
        free.el._postExecute(port, '1');
        expect(postMessage).toHaveBeenCalledWith({ type: 'EXECUTE', code: '1' });
    });
});

describe('a browser with Trusted Types', () => {
    it('decides itself: the text is not asked, so no refusal comes from the library', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        (globalThis as any).trustedTypes = { createPolicy: (_name: string, rules: any) => rules, defaultPolicy: null };
        const postMessage = vi.fn();
        const { el, reasons } = await mount({ mode: 'cooperative', capabilities: ['allow-scripts'], scriptUnsafe: true, hostContentSecurityPolicy: REQUIRING_OTHER });
        expect(reasons).toEqual([]);
        el._postExecute({ postMessage } as unknown as MessagePort, '1');
        expect(postMessage).toHaveBeenCalledWith({ type: 'EXECUTE', code: '1' });
    });
});
