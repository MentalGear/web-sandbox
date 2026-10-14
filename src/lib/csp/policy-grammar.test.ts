import { describe, it, expect } from 'vitest';
import { isSourceExpression, KNOWN_DIRECTIVES, sanitizeDirectives } from './policy-grammar';
import { generateCSP } from './csp-generator';
import type { CSPDirectives } from '@src/csp-directives';
import { parseLikeABrowser, prng, randomInjection } from '../../../test/unit/policy-helpers';

// The list must name exactly the keys of CSPDirectives: a directive added to one and not the other fails the type check.
type Known = (typeof KNOWN_DIRECTIVES)[number];
const sameKeys: [Exclude<keyof CSPDirectives, Known>, Exclude<Known, keyof CSPDirectives>] extends [never, never] ? true : false = true;
void sameKeys;

describe('the policy grammar (review A1, A2): one source expression per token', () => {
    it.each([
        "'self'", "'NONE'", "'unsafe-inline'", "'unsafe-eval'", "'wasm-unsafe-eval'", "'strict-dynamic'", "'unsafe-hashes'", "'report-sample'",
        "'nonce-abc123+/='", "'sha256-AbC/+9=='", "'sha384-a_b-c'", "'SHA512-x'",
        'https:', 'blob:', 'data:', 'wss:', 'ws:',
        '*', 'example.com', '*.example.com', 'https://example.com', 'https://*.example.com:*', 'http://localhost:4444', 'https://127.0.0.1:8443',
        'https://cdn.example/path/to/file.js', 'https://cdn.example/', 'cdn.example:443/a%20b',
    ])('%s is a source expression', (token) => {
        expect(isSourceExpression(token)).toBe(true);
    });

    it.each([
        "'self';", "'self',", "'none';", 'https://a.example;', 'https://a.example,', ';', ',', "'", "''", "'unsafe-inline", "unsafe-inline'",
        "'unknown-keyword'", "'nonce-'", "'sha1-abc'", '"self"', 'https://a.example/x;y', 'https://a.example/x,y', "https://a.example/'x'",
        'https://a.example/?q=1', 'https://a.example/#f', 'https://user@a.example', 'https://[::1]', 'a b', 'a\u000bb', 'a\u00a0b', 'é.example',
        'https://a.example\u0000', '<script>', 'javascript:alert(1)', 'https://', '://a', '*.', 'a..b',
    ])('%j is refused', (token) => {
        expect(isSourceExpression(token)).toBe(false);
    });

    it('drops unknown or misspelt directive names and every invalid token, each reported; values become one token per element', () => {
        const dropped: string[] = [];
        const result = sanitizeDirectives({
            'script-src': ["'unsafe-inline' https://cdn.example", "'self';"],
            'img-src https://a; script-src-elem': ['*'],
            'Script-Src': ['*'],
            'frame-src ': ['*'],
            'default-src': ["'none'; script-src-attr 'unsafe-inline'; frame-src *"],
            'upgrade-insecure-requests': true,
        } as unknown as CSPDirectives, (message) => dropped.push(message));
        expect(result).toEqual({
            'script-src': ["'unsafe-inline'", 'https://cdn.example'],
            // "'none';" dropped; the names that followed it are host-shaped tokens, now inside default-src only
            'default-src': ['script-src-attr', 'frame-src', '*'],
            'upgrade-insecure-requests': true,
        });
        expect(dropped.filter(m => m.includes('directive name'))).toHaveLength(3);
        expect(dropped.filter(m => m.includes('not one CSP source expression'))).toHaveLength(3); // "'self';", "'none';", "'unsafe-inline';"
    });

    it('leaves wrong value types for generateCSP to refuse, and never throws itself', () => {
        expect(sanitizeDirectives({ 'img-src': 32, 'font-src': [null] } as unknown as CSPDirectives)).toEqual({ 'img-src': 32, 'font-src': [null] });
        expect(() => generateCSP({ 'img-src': 32 } as unknown as CSPDirectives)).toThrowError('value type must be array');
    });
});

describe('generateCSP enforces the grammar itself (review A1): no value or key adds a directive', () => {
    it('the reviewers\' injections emit no directive the config did not name with a valid key', () => {
        const cases: [CSPDirectives, string][] = [
            [{ 'default-src': ["'none'; script-src-attr 'unsafe-inline'; script-src * 'unsafe-inline'; frame-src *"] }, "default-src script-src-attr script-src * frame-src;"],
            [{ 'connect-src': ['https://api.example; script-src-elem https:'] } as CSPDirectives, "default-src 'none'; connect-src script-src-elem https:;"],
            [{ 'img-src https://a; script-src-elem': ['*'] } as unknown as CSPDirectives, "default-src 'none';"],
            [{ 'img-src': ["'self',"] }, "default-src 'none'; img-src 'none';"],
        ];
        for (const [input, expected] of cases) expect(generateCSP(input)).toBe(expected);
    });
});

// ---- the property: whatever the config, a browser reads only the configured, valid directives -------------

describe('property (review A1): emitted directives are exactly the valid configured ones, each once, every token a source expression', () => {
    it('500 random configs with injected keys and values', () => {
        const random = prng(20261014);
        for (let run = 0; run < 500; run++) {
            const config: Record<string, string[]> = {};
            const names = [...KNOWN_DIRECTIVES.filter(n => n !== 'upgrade-insecure-requests')];
            for (let k = 0; k < 4; k++) {
                const key = random() < 0.5 ? names[Math.floor(random() * names.length)]! : randomInjection(random);
                config[key] = [randomInjection(random), randomInjection(random)];
            }
            const policy = generateCSP(config as CSPDirectives);
            const { names: emitted, directives } = parseLikeABrowser(policy);
            const expected = new Set(['default-src', ...Object.keys(config).filter(key => (KNOWN_DIRECTIVES as readonly string[]).includes(key))]);
            expect(new Set(emitted), JSON.stringify(config)).toEqual(expected);
            expect(emitted.length, JSON.stringify(config)).toBe(expected.size);
            for (const tokens of directives.values()) for (const token of tokens) expect(isSourceExpression(token), token).toBe(true);
        }
    });
});
