import { describe, it, expect, vi, afterEach } from 'vitest';
import { viewBootstrapHash } from '@src/lib/in-sandbox-view';
import { parseLikeABrowser } from './policy-helpers';

/**
 * Mutation gaps the verification found (VR; AR:A1, BR:CB7, FR:F5), host and library side: each is a test that fails under a mutation of the code that
 * the other tests do not catch.
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

describe('A1: a configured entry holding several sources never reaches the policy, in part or whole', () => {
    // Several sources in ONE entry: not an origin, so the whole entry is dropped (origin.ts). Before ADR-007 a grammar
    // had to split such an element before every later policy step, or eval, data: workers and 'self' went through.
    const MULTI = {
        scripts: ["https://s.example 'unsafe-eval'"],
        connect: ["https://a.example 'wasm-unsafe-eval'"],
        images: ["'self' https://i.example", 'https://i.example'],
        media: ['blob: data:'],
    };

    for (const mode of ['cooperative', 'worker', 'strict'] as const) {
        it(`${mode} mode: no eval keyword, no data:, no 'self' and no part of such an entry reaches the policy; a whole origin does`, async () => {
            const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
            const el = await mount({ mode, capabilities: ['allow-scripts'], origins: MULTI });
            expect(el.state).toBe('loading');
            const { directives } = parseLikeABrowser(policyOf(el));
            for (const [name, tokens] of directives) {
                for (const token of EVAL) expect(tokens.map(t => t.toLowerCase()), `${name} in ${mode}`).not.toContain(token);
                expect(tokens.map(t => t.toLowerCase()), `${name} in ${mode}`).not.toContain("'self'");
                expect(tokens, `${name} in ${mode}`).not.toContain('data:');
                expect(tokens, `${name} in ${mode}`).not.toContain('https://s.example');
                expect(tokens, `${name} in ${mode}`).not.toContain('https://a.example');
            }
            expect(directives.get('img-src')).toEqual(['https://i.example']);
            expect(directives.get('connect-src')).toEqual(["'none'"]);
            expect(directives.get('media-src')).toEqual(["'none'"]);
            expect(directives.get('worker-src')).toEqual(['blob:']);
            expect(directives.get('script-src')).toEqual(mode === 'strict' ? [viewBootstrapHash()] : ["'unsafe-inline'"]);
            expect(warn.mock.calls.map(c => String(c[0])).filter(m => m.includes('was dropped: list exact origins') || m.includes('origins.scripts is not used'))).toHaveLength(4);
        });
    }
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
    for (const mode of ['cooperative', 'worker', 'strict'] as const) {
        it(`${mode} mode with scriptUnsafe and origins: default-src stays 'none', the policy grants eval in script-src only`, async () => {
            vi.spyOn(console, 'warn').mockImplementation(() => {});
            const el = await mount({ mode, scriptUnsafe: true, capabilities: ['allow-scripts'], origins: { connect: ['https://a.example'], images: ['https://a.example'] } });
            const { directives } = parseLikeABrowser(policyOf(el));
            expect(directives.get('default-src')).toEqual(["'none'"]);
            expect(directives.get('script-src')).toContain("'unsafe-eval'");
            for (const [name, tokens] of directives) if (name !== 'script-src') expect(tokens, name).not.toContain("'unsafe-eval'");
        });
    }
});
