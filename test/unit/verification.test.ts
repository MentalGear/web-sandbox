import { describe, it, expect, vi, afterEach } from 'vitest';
import type { CSPDirectives } from '@src/csp-directives';
import { addEvalSource, directiveOf } from '@src/lib/csp/effective-directive';
import { policyTokens, sanitizeDirectives } from '@src/lib/csp/policy-grammar';
import { viewBootstrapHash } from '@src/lib/in-sandbox-view';
import { parseLikeABrowser, prng } from './policy-helpers';

/**
 * Independent verification 2026-10-14 (docs/security/VERIFICATION-2026-10-14.md), host and library side: the gaps
 * where a mutation of the code survived every earlier test, each now a test that fails under that mutation.
 */

const parse = (html: string) => new DOMParser().parseFromString(html, 'text/html');
const wrapperOf = (el: HTMLElement) => el.shadowRoot!.querySelector('iframe');
const policyOf = (el: HTMLElement) => {
    const inner = parse(wrapperOf(el)!.srcdoc).querySelector('iframe')!.getAttribute('srcdoc')!;
    return parse(inner).querySelector('meta[http-equiv="Content-Security-Policy"]')!.getAttribute('content')!;
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

const EVAL = ["'unsafe-eval'", "'wasm-unsafe-eval'"];

describe('A1: the policy steps see the grammar\'s tokens, never a configured element holding several sources', () => {
    // Several sources in ONE array element: the host's grammar splits them before any step (drop-eval, drop-data-workers,
    // file sources, drop-self, the strict view) reads the lists one element at a time. Without that first split, each
    // of these went through: eval in iframe and worker mode, data: workers, wasm-unsafe-eval in the strict view.
    const MULTI: CSPDirectives = {
        'script-src': ["'unsafe-inline' 'unsafe-eval'"],
        'default-src': ["https://a.example 'wasm-unsafe-eval'"],
        'worker-src': ['blob: data:'],
        'img-src': ["'self' https://i.example"],
    };

    for (const mode of ['iframe', 'worker', 'strict'] as const) {
        it(`${mode} mode: no eval keyword, no data: worker, no 'self' reaches the final policy; the other sources do`, async () => {
            vi.spyOn(console, 'warn').mockImplementation(() => {});
            const el = await mount({ mode, capabilities: ['allow-scripts'], connectionsAllowed: MULTI });
            expect(el.state).toBe('loading');
            const { directives } = parseLikeABrowser(policyOf(el));
            for (const [name, tokens] of directives) {
                for (const token of EVAL) expect(tokens.map(t => t.toLowerCase()), `${name} in ${mode}`).not.toContain(token);
                expect(tokens.map(t => t.toLowerCase()), `${name} in ${mode}`).not.toContain("'self'");
            }
            expect(directives.get('default-src')).toEqual(['https://a.example']);
            expect(directives.get('img-src')).toEqual(['https://i.example']);
            if (mode === 'strict') {
                expect(directives.get('script-src')).toEqual([viewBootstrapHash()]);
                expect(directives.get('worker-src')).toEqual(['blob:']);
            } else {
                expect(directives.get('script-src')).toEqual(["'unsafe-inline'"]);
                expect(directives.get('worker-src')).toEqual(['blob:']);
            }
        });
    }

    it('by construction: every step refuses a list element that is not one token (a caller that skipped the grammar fails closed)', async () => {
        const { dropEvalSources } = await import('@src/lib/csp/drop-eval');
        const { dropDataWorkerSources } = await import('@src/lib/csp/drop-data-workers');
        const { dropSelfSources } = await import('@src/lib/csp/drop-self');
        const { addFileSources } = await import('@src/lib/csp/file-sources');
        const { strictPassedThrough, strictViewDirectives } = await import('@src/lib/csp/strict-policy');
        const raw = MULTI as never;
        const steps: [string, () => unknown][] = [
            ['dropEvalSources', () => dropEvalSources(raw, false, new Set())],
            ['dropDataWorkerSources', () => dropDataWorkerSources(raw, new Set())],
            ['dropSelfSources', () => dropSelfSources(raw, new Set())],
            ['addFileSources', () => addFileSources(raw, ['image/png'], new Set())],
            ['addEvalSource', () => addEvalSource(raw)],
            ['strictPassedThrough', () => strictPassedThrough(raw)],
            ['strictViewDirectives', () => strictViewDirectives(raw, "'sha256-x'", false)],
        ];
        for (const [name, step] of steps) expect(step, name).toThrowError(new RegExp(`the policy step ${name} was given`));
        // the grammar's output is accepted by all of them
        const grammatical = sanitizeDirectives(MULTI);
        expect(() => dropEvalSources(grammatical, false, new Set())).not.toThrow();
    });
});

describe('CB7: the lifecycle callbacks reach the element through the class, so they work on an element whose prototype Firefox replaced', () => {
    // Firefox gives an element adopted into another document that document's HTMLElement prototype; the custom element
    // callbacks still run (the registry keeps them), with `this` lacking every method of the class. Simulated here.
    const foreign = (el: HTMLElement) => Object.setPrototypeOf(el, HTMLElement.prototype);
    const stateOf = async (el: HTMLElement) => {
        const { WebSandbox } = await import('@src/host');
        return Object.getOwnPropertyDescriptor(WebSandbox.prototype, 'state')!.get!.call(el);
    };

    it('adoptedCallback alone, on such an element, tears the environment down: the frame is gone and the state is idle', async () => {
        const { WebSandbox } = await import('@src/host');
        const el = await mount({ capabilities: ['allow-scripts'] });
        expect(wrapperOf(el)).not.toBeNull();
        foreign(el);
        expect(() => WebSandbox.prototype.adoptedCallback.call(el)).not.toThrow();
        expect(el.shadowRoot!.querySelector('iframe')).toBeNull();
        expect(await stateOf(el)).toBe('idle');
    });

    it('disconnectedCallback likewise', async () => {
        const { WebSandbox } = await import('@src/host');
        const el = await mount({ capabilities: ['allow-scripts'] });
        foreign(el);
        expect(() => WebSandbox.prototype.disconnectedCallback.call(el)).not.toThrow();
        expect(el.shadowRoot!.querySelector('iframe')).toBeNull();
        expect(await stateOf(el)).toBe('idle');
    });

    it('connectedCallback in another window\'s document builds nothing and warns once; back home, the element gets its class back and builds', async () => {
        const { WebSandbox } = await import('@src/host');
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const el = await mount({ capabilities: ['allow-scripts'] });
        const other = document.implementation.createHTMLDocument('other');
        foreign(el);
        Object.defineProperty(el, 'ownerDocument', { configurable: true, get: () => other });
        WebSandbox.prototype.connectedCallback.call(el);
        WebSandbox.prototype.connectedCallback.call(el);
        expect(el.shadowRoot!.querySelector('iframe')).toBeNull();
        expect(warn.mock.calls.map(c => String(c[0])).filter(m => m.includes('a document of another window'))).toHaveLength(1);
        delete (el as any).ownerDocument;
        WebSandbox.prototype.connectedCallback.call(el);
        expect(Object.getPrototypeOf(el)).toBe(WebSandbox.prototype);
        expect(el.shadowRoot!.querySelector('iframe')).not.toBeNull();
        expect((el as any).state).toBe('loading');
    });
});

describe("F5: 'unsafe-eval' is never written into default-src", () => {
    it('where default-src governs string compilation, addEvalSource creates script-src from its sources and leaves default-src as it was', () => {
        const policy = policyTokens({ 'default-src': ['https://a.example', "'unsafe-inline'"], 'img-src': ['data:'] }, 'test');
        const out = addEvalSource(policy);
        expect(out['default-src']).toEqual(['https://a.example', "'unsafe-inline'"]);
        expect(out['script-src']).toEqual(['https://a.example', "'unsafe-inline'", "'unsafe-eval'"]);
    });

    it('property: over 300 random policies, default-src after addEvalSource is the one before, and the eval keyword is in script-src', () => {
        const random = prng(20261014);
        const NAMES = ['default-src', 'script-src', 'style-src', 'img-src', 'connect-src', 'worker-src', 'child-src', 'script-src-elem'];
        const TOKENS = ["'none'", "'unsafe-inline'", 'https://a.example', 'blob:', 'data:', '*', "'sha256-AAAA'"];
        for (let run = 0; run < 300; run++) {
            const policy: Record<string, string[]> = {};
            for (const name of NAMES) {
                if (random() < 0.5) continue;
                policy[name] = Array.from({ length: Math.floor(random() * 3) }, () => TOKENS[Math.floor(random() * TOKENS.length)]!);
            }
            const out = addEvalSource(policyTokens(policy as CSPDirectives, 'test'));
            const context = JSON.stringify(policy);
            expect(directiveOf(out, 'default-src'), context).toEqual(directiveOf(policy as CSPDirectives, 'default-src'));
            expect(directiveOf(out, 'script-src'), context).toContain("'unsafe-eval'");
        }
    });

    for (const mode of ['iframe', 'worker', 'strict'] as const) {
        it(`${mode} mode with scriptUnsafe and a configured default-src: the policy grants eval in script-src only`, async () => {
            vi.spyOn(console, 'warn').mockImplementation(() => {});
            const el = await mount({ mode, scriptUnsafe: true, capabilities: ['allow-scripts'], connectionsAllowed: { 'default-src': ['https://a.example'] } });
            const { directives } = parseLikeABrowser(policyOf(el));
            expect(directives.get('default-src')).toEqual(['https://a.example']);
            expect(directives.get('script-src')).toContain("'unsafe-eval'");
        });
    }
});
