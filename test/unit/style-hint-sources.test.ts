import { afterEach, describe, expect, it, vi } from 'vitest';
import { connectSources } from '@src/lib/csp/host-connect';
import { scriptHashSource } from '@src/lib/csp/script-hash';
import { WRAPPER_STYLE } from '@src/lib/frame-documents';
import { VIEW_STILL_STYLE } from '@src/lib/in-sandbox-view';

/**
 * The warnings that tell the embedder what to add to `style-src` (BD3:NEW-2, class C: one place says what a source looks
 * like). The hint is copied into a policy, so it must be a source a browser parses: `'sha256-…'` once quoted, not
 * `''sha256-…''`, which no browser reads as a source (the style stays refused). Both hints are read back here as the
 * policy would read them.
 */

afterEach(() => {
    vi.restoreAllMocks();
    document.body.replaceChildren();
});

/** CSP3's hash-source: a quoted algorithm name, a hyphen and a base64 (or base64url) value. */
const HASH_SOURCE = /^'(sha256|sha384|sha512)-([A-Za-z0-9+/_-]+={0,2})'$/;
const DIGEST_BYTES = { sha256: 32, sha384: 48, sha512: 64 } as const;

/** The source the hint asks the embedder to allow: what follows "'unsafe-inline' or" in "Allow … in style-src". */
function hintedSource(message: string): string {
    const match = /Allow 'unsafe-inline' or (\S+) in style-src/.exec(message);
    expect(match, message).not.toBeNull();
    return match![1]!;
}

/** What a serialized policy that took the hint as written would make of it: the sources of a directive. */
function asPolicySources(source: string): readonly string[] {
    const policy = connectSources(`connect-src 'self' ${source}`);
    return policy.restricts ? policy.sources : [];
}

function expectsAHashSource(source: string, wanted: string) {
    expect(source).toBe(wanted);
    const grammar = HASH_SOURCE.exec(source);
    expect(grammar, `${source} is a hash-source`).not.toBeNull();
    const algorithm = grammar![1] as keyof typeof DIGEST_BYTES;
    expect(Buffer.from(grammar![2]!, 'base64').length, 'the value decodes to a whole digest').toBe(DIGEST_BYTES[algorithm]);
    expect(asPolicySources(source), 'one source of the policy, not two, and not a quote left open').toEqual(["'self'", source]);
}

async function element() {
    const { defineWebSandbox } = await import('@src/host');
    defineWebSandbox();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const el = document.createElement('web-sandbox') as any;
    document.body.appendChild(el);
    const said = (pattern: RegExp) => warn.mock.calls.map(call => String(call[0])).filter(message => pattern.test(message));
    return { el, said };
}

describe('the style-src hints are sources a policy can take', () => {
    it("the wrapper's style: a view 150 px high in a taller frame names its hash as one source", async () => {
        const { el, said } = await element();
        el.setConfig({ mode: 'strict' });
        Object.defineProperty(el._iframe, 'clientHeight', { configurable: true, value: 300 });
        el._checkViewSize(150);
        const [message] = said(/refuses the wrapper's style/);
        expectsAHashSource(hintedSource(message!), scriptHashSource(WRAPPER_STYLE));
        expect(message).not.toContain("''");
    });

    it("the view's still stylesheet: the allowAnimations warning names its hash as one source", async () => {
        const { el, said } = await element();
        el.setConfig({ mode: 'strict', allowAnimations: false });
        const { port1 } = new MessageChannel();
        el._viewPort = port1;
        el._onViewMessage(port1, { type: 'VIEW_READY', width: 400, height: 300, stillStyleRefused: true });
        const [message] = said(/stops animations/);
        expectsAHashSource(hintedSource(message!), scriptHashSource(VIEW_STILL_STYLE));
        expect(message).not.toContain("''");
        port1.close();
    });

    it('the reader rejects the doubled form the hints used to give, so the check above can fail', () => {
        const hash = scriptHashSource(WRAPPER_STYLE);
        expect(() => expectsAHashSource(`'${hash}'`, hash)).toThrow();
        expect(HASH_SOURCE.test(`'${hash}'`)).toBe(false);
        expect(HASH_SOURCE.test(hash)).toBe(true);
    });
});
