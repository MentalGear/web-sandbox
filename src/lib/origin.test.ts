import { describe, it, expect } from 'vitest';
import { ORIGIN_PATTERN, parseOrigin, type OriginRules } from './origin';
import { FETCH_ORIGIN_RULES } from './fetch-bridge';

// The guest policy's rules (ADR-007; csp/origins.test.ts checks originRules() against these): https everywhere, wss for
// connect, plain http only for loopback.
const CONNECT: OriginRules = { anyHost: ['https:', 'wss:'], loopbackOnly: ['http:'] };
const IMAGES: OriginRules = { anyHost: ['https:'], loopbackOnly: ['http:'] };

describe('parseOrigin: the one origin parser (origins and fetchBridge.allow)', () => {
    it.each<[string, string]>([
        ['https://api.example', 'https://api.example'],
        ['https://api.example/', 'https://api.example'],
        ['HTTPS://API.Example', 'https://api.example'],                 // case is folded
        ['https://api.example:443', 'https://api.example'],              // a default port is dropped
        ['https://api.example:8443/', 'https://api.example:8443'],
        ['https://127.0.0.1:9000', 'https://127.0.0.1:9000'],            // an IPv4 address as written
        ['https://xn--bcher-kva.example', 'https://xn--bcher-kva.example'], // IDNA in its ASCII form
        ['https://a-b.c-d.example', 'https://a-b.c-d.example'],
        ['https://intranet', 'https://intranet'],
        ['http://localhost:5173', 'http://localhost:5173'],              // loopback over http: local development
        ['http://127.0.0.1:8080', 'http://127.0.0.1:8080'],
        ['http://localhost:80', 'http://localhost'],
    ])('accepts %s as %s', (entry, origin) => {
        expect(parseOrigin(entry, IMAGES)).toBe(origin);
        expect(ORIGIN_PATTERN.test(origin)).toBe(true);
    });

    it.each<[string, unknown]>([
        ['a scheme-wide source', 'https:'],
        ['a wildcard', '*'],
        ['a wildcard host', 'https://*.example'],
        ['a wildcard port', 'https://a.example:*'],
        ['a keyword', "'self'"],
        ['a keyword without quotes', 'self'],
        ['data:', 'data:'],
        ['blob:', 'blob:'],
        ['a blob URL', 'blob:https://a.example/x'],
        ['a host without a scheme', 'api.example'],
        ['a path', 'https://api.example/v1'],
        ['a query', 'https://api.example/?q'],
        ['a fragment', 'https://api.example/#x'],
        ['userinfo', 'https://u:p@api.example'],
        ['userinfo, user only', 'https://u@api.example'],
        ['a trailing dot', 'https://api.example.'],
        ['an empty label', 'https://api..example'],
        ['a label ending in -', 'https://api-.example'],
        ['an underscore (CSP cannot write it)', 'https://my_host.example'],
        ['a non-ASCII host (write the xn-- form)', 'https://bücher.example'],
        ['a fullwidth dot', 'https://a．example'],
        ['a percent-encoded dot', 'https://a%2eexample'],
        ['percent-encoding anywhere', 'https://%61.example'],
        ['IPv4 shorthand', 'https://127.1'],
        ['IPv4 in hex', 'https://0x7f.0.0.1'],
        ['IPv4 in octal', 'https://0177.0.0.1'],
        ['IPv4 as one number', 'https://2130706433'],
        ['IPv4 with leading zeros', 'https://127.000.0.1'],
        ['an invalid IPv4', 'https://999.1.1.1'],
        ['IPv6 loopback', 'https://[::1]'],
        ['IPv4-mapped IPv6', 'https://[::ffff:127.0.0.1]'],
        ['a leading space', ' https://a.example'],
        ['a trailing space', 'https://a.example '],
        ['a tab inside (the URL parser would remove it)', 'https://a.exa\tmple'],
        ['a newline inside', 'https://a.example\n'],
        ['a semicolon', 'https://a.example;'],
        ['a semicolon and a directive', "https://a.example; script-src 'unsafe-inline'"],
        ['a comma', 'https://a.example,https://b.example'],
        ['a quote', "https://a.example'"],
        ['a backslash', 'https:\\\\a.example'],
        ['one slash', 'https:/a.example'],
        ['a port with a leading zero', 'https://a.example:0443'],
        ['port 0', 'https://a.example:0'],
        ['a port out of range', 'https://a.example:65536'],
        ['an empty port', 'https://a.example:'],
        ['plain http to a public host', 'http://api.example'],
        ['plain http to a loopback name that is not exactly localhost', 'http://a.localhost'],
        ['plain http to another loopback address', 'http://127.0.0.2'],
        ['wss outside connect', 'wss://a.example'],
        ['ws', 'ws://localhost'],
        ['ftp', 'ftp://a.example'],
        ['javascript:', 'javascript:alert(1)'],
        ['an empty string', ''],
        ['a number', 42],
        ['null', null],
        ['an object', { toString: () => 'https://a.example' }],
        ['an array', ['https://a.example']],
        ['too long', `https://${'a.'.repeat(1100)}example`],
    ])('refuses %s', (_, entry) => {
        expect(parseOrigin(entry, IMAGES)).toBeNull();
    });

    it('wss: only where the rules admit it (connect), for any host; plain http only for loopback there too', () => {
        expect(parseOrigin('wss://ws.example', CONNECT)).toBe('wss://ws.example');
        expect(parseOrigin('WSS://ws.example:443/', CONNECT)).toBe('wss://ws.example');
        expect(parseOrigin('wss://ws.example:8443', CONNECT)).toBe('wss://ws.example:8443');
        expect(parseOrigin('http://localhost:3000', CONNECT)).toBe('http://localhost:3000');
        expect(parseOrigin('http://api.example', CONNECT)).toBeNull();
        expect(parseOrigin('ws://localhost:3000', CONNECT)).toBeNull();
    });

    it("fetchBridge.allow: https and http, for any host, under the same grammar", () => {
        expect(parseOrigin('http://api.example:8080', FETCH_ORIGIN_RULES)).toBe('http://api.example:8080');
        expect(parseOrigin('https://API.example:443/', FETCH_ORIGIN_RULES)).toBe('https://api.example');
        for (const entry of ['wss://a.example', 'https://a.example.', 'https://[::1]', 'https://127.1', 'https://a%2eexample', ' https://a.example', 'https://bücher.example']) {
            expect(parseOrigin(entry, FETCH_ORIGIN_RULES), entry).toBeNull();
        }
    });

    it('property: whatever it returns matches ORIGIN_PATTERN and parses back to itself', () => {
        let seed = 20261014;
        const random = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 0x100000000);
        const PARTS = ['https://', 'http://', 'wss://', 'HTTPS://', 'a', 'example', '.', '-', ':', '443', '8080', '0', '/', '%2e', '@', '*', ' ', ';', "'", '[::1]', '127', '0x7f', 'localhost', 'xn--', 'ü', '\\', '\t'];
        for (let run = 0; run < 5000; run++) {
            let entry = '';
            for (let i = 1 + Math.floor(random() * 8); i > 0; i--) entry += PARTS[Math.floor(random() * PARTS.length)];
            for (const rules of [CONNECT, IMAGES, FETCH_ORIGIN_RULES]) {
                const origin = parseOrigin(entry, rules);
                if (origin === null) continue;
                expect(ORIGIN_PATTERN.test(origin), JSON.stringify(entry)).toBe(true);
                expect(parseOrigin(origin, rules), JSON.stringify(entry)).toBe(origin);
            }
        }
    });
});
