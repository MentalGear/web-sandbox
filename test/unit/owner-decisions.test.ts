import { describe, it, expect, vi, afterEach } from 'vitest';
import { SAFE_CAPABILITIES, UNSAFE_CAPABILITIES, UNSAFE_SANDBOX_FLAGS } from '@src/csp-directives';

/**
 * The owner's decisions after review round 1 (docs/security/REVIEW-ROUND-1-2026-10-15.md, "Awaiting the owner"), each
 * reproduced here first where library logic decides: R2-2 (`allow-forms` is an unsafe capability in cooperative mode).
 * The browser's side of each is test/e2e/owner-decisions.spec.ts, on all three engines.
 */

const parse = (html: string) => new DOMParser().parseFromString(html, 'text/html');
const wrapperOf = (el: HTMLElement) => el.shadowRoot!.querySelector('iframe')!;
const flagsOf = (el: HTMLElement) => {
    const wrapper = wrapperOf(el);
    return [wrapper.getAttribute('sandbox'), parse(wrapper.srcdoc).querySelector('iframe')!.getAttribute('sandbox')];
};

async function mount(config: Record<string, unknown>) {
    const { defineWebSandbox } = await import('@src/host');
    defineWebSandbox();
    const el = document.createElement('web-sandbox') as any;
    document.body.appendChild(el);
    el.setConfig(config);
    return el;
}

afterEach(() => {
    vi.restoreAllMocks();
    document.body.replaceChildren();
});

describe('R2-2: allow-forms is an unsafe capability (cooperative and worker mode); strict mode always has it', () => {
    const warnings = () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        return () => warn.mock.calls.map(call => String(call[0]));
    };

    it('the lists: allow-forms is an unsafe sandbox flag, not a safe capability', () => {
        expect(SAFE_CAPABILITIES as readonly string[]).not.toContain('allow-forms');
        expect(UNSAFE_CAPABILITIES as readonly string[]).toContain('allow-forms');
        expect(UNSAFE_SANDBOX_FLAGS as readonly string[]).toContain('allow-forms');
    });

    it("cooperative mode: capabilities: ['allow-forms'] is dropped with a warning that names unsafeCapabilities; no frame gets the flag", async () => {
        const messages = warnings();
        const el = await mount({ mode: 'cooperative', capabilities: ['allow-scripts', 'allow-forms'] });
        expect(flagsOf(el)).toEqual(['allow-scripts', 'allow-scripts']);
        const dropped = messages().filter(message => message.includes('"allow-forms" is not allowed in "capabilities"'));
        expect(dropped).toHaveLength(1);
        expect(dropped[0]).toContain('unsafeCapabilities');
    });

    it("cooperative mode: unsafeCapabilities: ['allow-forms'] is accepted on both frames, with the one unsafe-capability warning", async () => {
        const messages = warnings();
        const el = await mount({ mode: 'cooperative', capabilities: ['allow-scripts'], unsafeCapabilities: ['allow-forms'] });
        el.reset();
        expect(flagsOf(el)).toEqual(['allow-scripts allow-forms', 'allow-scripts allow-forms']);
        expect(messages().filter(message => message.includes('"allow-forms"'))).toEqual(['[Sandbox] unsafe capability "allow-forms" is enabled: it lets guest content act outside the sandbox.']);
    });

    it("worker mode: the same lists (unsafeCapabilities: ['allow-forms'] accepted with the warning)", async () => {
        const messages = warnings();
        const el = await mount({ mode: 'worker', unsafeCapabilities: ['allow-forms'] });
        expect(flagsOf(el)).toEqual(['allow-forms allow-scripts', 'allow-forms allow-scripts']);
        expect(messages().filter(message => message.includes('"allow-forms"'))).toEqual(['[Sandbox] unsafe capability "allow-forms" is enabled: it lets guest content act outside the sandbox.']);
    });

    it("strict mode is unchanged: its view always has allow-scripts allow-forms; capabilities: ['allow-forms'] is that and warns nothing; unsafeCapabilities are dropped as before", async () => {
        const messages = warnings();
        expect(flagsOf(await mount({ mode: 'strict' }))).toEqual(['allow-scripts allow-forms', 'allow-scripts allow-forms']);
        expect(flagsOf(await mount({ mode: 'strict', capabilities: ['allow-forms', 'allow-pointer-lock'] }))).toEqual(['allow-scripts allow-forms allow-pointer-lock', 'allow-scripts allow-forms allow-pointer-lock']);
        expect(flagsOf(await mount({ capabilities: ['allow-forms'] }))).toEqual(['allow-scripts allow-forms', 'allow-scripts allow-forms']); // no mode: strict
        expect(messages().filter(message => message.includes('allow-forms'))).toEqual([]);
        expect(flagsOf(await mount({ mode: 'strict', unsafeCapabilities: ['allow-forms'] }))).toEqual(['allow-scripts allow-forms', 'allow-scripts allow-forms']);
        expect(messages().filter(message => message.includes('allow-forms'))).toEqual(['[Sandbox] unsafeCapabilities are not available in strict mode and were dropped: allow-forms.']);
    });
});
