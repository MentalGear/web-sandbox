import { beforeAll, describe, expect, it } from 'vitest';
import { connectSources } from '@src/lib/csp/csp-generator';
import { parseOrigins } from '@src/lib/csp/origins';
import { GATE_SOURCE_FILE } from '@src/lib/violation';
import { createGateHarness } from './request-gate-harness';

/**
 * Strict mode's request gate opens no WebSocket (S74, class A: strict mode has no cookie carrier, STRICT_COOKIE_CARRIERS in
 * cookie-facts.ts). A handshake carries the cookies the browser attaches by site, which nothing strips, so the gate refuses
 * every `new WebSocket()` there, whatever its list says, with the shape of any refusal (a SecurityError, and a report of
 * `connect-src` that is the gate's own), and never calls the platform's constructor. `origins` keeps no `wss://` entry in
 * strict mode either (origins.ts), so this file gives the gate a list that has one anyway: the gate does not rely on it.
 *
 * Positive control: fetch() to the same listed origin is admitted, and request-gate.test.ts runs the same gate in worker
 * mode, where a listed `wss://` origin opens.
 */

// A list with a wss:// source, as worker mode's policy would have it: strict mode's never does (origins.ts).
const CONNECT = connectSources({
    origins: parseOrigins({ connect: ['https://api.example', 'wss://api.example'] }, 'worker', () => {}),
    fileKinds: new Set(),
    scriptUnsafe: false,
});
const REFUSAL = 'WebSocket refused by the sandbox: strict mode opens no WebSocket';

const gate = createGateHarness();
const { fetched, sockets, reports, clear } = gate;

beforeAll(() => gate.install(CONNECT, { mode: 'strict' }));

const outcome = (make: () => unknown): string => {
    try {
        make();
        return 'made';
    } catch (error) {
        return `${(error as Error).name}: ${(error as Error).message}`;
    }
};

describe('strict mode: every WebSocket is refused and reported, the listed origin too', () => {
    it('the list the gate is given names the wss:// origin (so the refusal is not the list\'s doing)', () => {
        expect(CONNECT).toEqual(['https://api.example', 'wss://api.example']);
    });

    it.each([
        ['wss://api.example/listed', 'wss://api.example/listed'],
        ['https://api.example/listed-https', 'wss://api.example/listed-https'],
        ['wss://evil.example/x', 'wss://evil.example/x'],
        ['ws://localhost:3000/x', 'ws://localhost:3000/x'],
        ['wss://user:pw@api.example/p?q#f', 'wss://api.example/p?q'],
    ])('%s: a SecurityError and one report, and the platform is never asked', (url, blockedURI) => {
        clear();
        expect(outcome(() => new WebSocket(url))).toBe(`SecurityError: ${REFUSAL}`);
        expect(outcome(() => new WebSocket(url, ['chat']))).toBe(`SecurityError: ${REFUSAL}`);
        expect(sockets).toEqual([]);
        expect(reports()).toEqual([1, 2].map(() => ({ type: 'VIOLATION', directive: 'connect-src', blockedURI, sourceFile: GATE_SOURCE_FILE })));
    });

    it('a URL that is not a WebSocket URL is a SyntaxError, as anywhere, and no argument at all a TypeError: neither reaches the platform', () => {
        clear();
        expect(outcome(() => new WebSocket('data:text/plain,x'))).toMatch(/^SyntaxError: /);
        expect(outcome(() => new (WebSocket as unknown as new () => WebSocket)())).toMatch(/^TypeError: /);
        expect(outcome(() => (WebSocket as unknown as (url: string) => unknown)('wss://api.example/x'))).toMatch(/^TypeError: /);
        expect(sockets).toEqual([]);
        expect(reports()).toEqual([]);
    });

    it('positive control: fetch() to the listed origin is admitted, so the gate is installed and its list read', async () => {
        clear();
        expect(await fetch('https://api.example/ok').then(response => response.status)).toBe(200);
        expect(fetched.map(entry => entry.url)).toEqual(['https://api.example/ok']);
        expect(reports()).toEqual([]);
    });

    it('the constructor is still the gated one, with the platform\'s prototype and statics', () => {
        expect(WebSocket.prototype.constructor).toBe(WebSocket);
        expect(WebSocket.prototype).toBe(gate.PlatformWebSocket.prototype);
        expect((WebSocket as unknown as { OPEN: number }).OPEN).toBe(1);
    });
});
