import { describe, it, expect, vi, afterEach } from 'vitest';
import { dropSelfSources } from './drop-self';
import { generateCSP } from './csp-generator';
import type { CSPDirectives } from '@src/csp-directives';
import { policyTokens, sanitizeDirectives, type PolicyTokens } from './policy-grammar';

// the policy steps take only the grammar's output (PolicyTokens, A1): test policies are checked into it
const tokens = (directives: CSPDirectives) => policyTokens(directives, 'test');

describe('dropSelfSources', () => {
    afterEach(() => { vi.restoreAllMocks(); });
    const quiet = () => vi.spyOn(console, 'warn').mockImplementation(() => {});

    it("removes 'self' from every directive, in any case and however often it appears", () => {
        quiet();
        const out = dropSelfSources(tokens({
            'default-src': ["'SELF'"],
            'script-src': ["'self'", "'unsafe-inline'", "'Self'", 'https://cdn.example'],
            'connect-src': ['https://api.example', "'self'", "'self'"],
            'img-src': ["'sElF'", 'data:'],
            'base-uri': ["'self'"],
            'form-action': ["'self'"],
            'worker-src': ['blob:', "'self'"],
        }), new Set());

        // a directive emptied by the drop stays empty: generateCSP emits it as 'none' (S16, last test)
        expect(out).toEqual({
            'default-src': [],
            'script-src': ["'unsafe-inline'", 'https://cdn.example'],
            'connect-src': ['https://api.example'],
            'img-src': ['data:'],
            'base-uri': [],
            'form-action': [],
            'worker-src': ['blob:'],
        });
    });

    it("removes 'self' carried inside a space-separated value: the grammar splits it into tokens first, and the step refuses a value that is not one token (A1)", () => {
        quiet();
        const configured: CSPDirectives = { 'script-src': ["'unsafe-inline' 'self' https://a.example"] };
        expect(dropSelfSources(sanitizeDirectives(configured), new Set())).toEqual({ 'script-src': ["'unsafe-inline'", 'https://a.example'] });
        expect(() => dropSelfSources(configured as PolicyTokens, new Set())).toThrowError(/dropSelfSources was given .* which is not one source/);
    });

    it('leaves other sources, other directives and non-array values untouched, and does not warn', () => {
        const warn = quiet();
        const input: CSPDirectives = {
            'upgrade-insecure-requests': true,
            'default-src': ["'none'"],
            'script-src': ["'unsafe-inline'", 'https://self.example', "'self-ish'"],
            'img-src': [],
        };
        expect(dropSelfSources(tokens(input), new Set())).toEqual(input);
        expect(warn).not.toHaveBeenCalled();
    });

    it('does not modify its input', () => {
        quiet();
        const input: CSPDirectives = { 'script-src': ["'self'", "'unsafe-inline'"] };
        dropSelfSources(tokens(input), new Set());
        expect(input).toEqual({ 'script-src': ["'self'", "'unsafe-inline'"] });
    });

    it('warns once per directive per instance, naming the directive', () => {
        const warn = quiet();
        const warned = new Set<string>(); // one instance's memory
        const config: CSPDirectives = { 'script-src': ["'self'", "'SELF'"], 'img-src': ["'self'"], 'style-src': ["'unsafe-inline'"] };

        dropSelfSources(tokens(config), warned);
        dropSelfSources(tokens(config), warned); // e.g. the same element after reset()

        expect(warn).toHaveBeenCalledTimes(2);
        expect(warn.mock.calls[0]?.[0]).toContain('"connectionsAllowed.script-src"');
        expect(warn.mock.calls[1]?.[0]).toContain('"connectionsAllowed.img-src"');
        expect(warn.mock.calls[0]?.[0]).toContain("[Sandbox] \"'self'\" is not allowed");

        dropSelfSources(tokens(config), new Set()); // another instance warns again
        expect(warn).toHaveBeenCalledTimes(4);
    });

    it("an all-'self' directive is emitted as 'none' rather than omitted (no fallback to a broader default-src)", () => {
        quiet();
        const csp = generateCSP(dropSelfSources(tokens({
            'default-src': ['https://broad.example'],
            'script-src': ["'self'"],
            'connect-src': ["'self'"],
        }), new Set()));
        expect(csp).toBe("default-src https://broad.example; script-src 'none'; connect-src 'none';");
    });
});
