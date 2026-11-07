import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GATE_SOURCE_FILE } from '@src/lib/violation';
import { createGateHarness } from './request-gate-harness';

/**
 * A blob worker's location is `blob:null/<uuid>`, a base with no path to resolve a relative reference against (BD6:NEW-2).
 * XMLHttpRequest.open() of a relative URL there is a refused request in the gate's words, reported as the text the guest
 * wrote, the way an absolute URL outside the list is; it is not a SyntaxError of "the URL does not parse". A URL that parses
 * on its own still resolves, and one that parses nowhere still throws the SyntaxError.
 */

const gate = createGateHarness();
const { opened, sent, reports, clear } = gate;
const saved = Object.getOwnPropertyDescriptor(globalThis, 'location');

beforeAll(() => {
    Object.defineProperty(globalThis, 'location', { value: new URL('blob:null/0b3c1f5e-8f2a-4a3e-9d57-2f4f8d3d7a11'), configurable: true });
    gate.install([], { mode: 'strict', sealedMode: true });
});
afterAll(() => {
    if (saved) Object.defineProperty(globalThis, 'location', saved);
});

describe('a relative XMLHttpRequest URL against a base that cannot resolve one (BD6:NEW-2)', () => {
    it.each(['/rel?q#f', 'rel', '../up', '//elsewhere.example/x'])('open(%s) does not throw, send() is refused in the gate\'s words, and it is reported', (url) => {
        clear();
        const request = new XMLHttpRequest();
        expect(() => request.open('GET', url, false)).not.toThrow();
        expect(() => request.send()).toThrow(expect.objectContaining({ name: 'NetworkError', message: 'XMLHttpRequest refused by the sandbox: sealed mode has no network; call a method the host page exposes instead' }));
        expect(opened).toEqual(['about:blank']); // a placeholder the platform is never asked to send
        expect(sent).toEqual([]);
        expect(reports()).toEqual([expect.objectContaining({ type: 'VIOLATION', directive: 'connect-src', sourceFile: GATE_SOURCE_FILE })]);
    });

    it('an absolute URL is refused as before, and a URL that parses nowhere still throws the SyntaxError', () => {
        clear();
        const request = new XMLHttpRequest();
        expect(() => request.open('GET', 'https://api.example/x')).not.toThrow();
        expect(() => request.open('GET', 'http://')).toThrow(expect.objectContaining({ name: 'SyntaxError', message: 'the URL does not parse' }));
    });
});

describe('a relative WebSocket URL against a base that cannot resolve one (BD6:NEW-2)', () => {
    it.each(['/socket', 'socket', '//elsewhere.example/socket'])('new WebSocket(%s) is refused in the gate\'s words and reported, not a parse error', (url) => {
        clear();
        expect(() => new WebSocket(url)).toThrow(expect.objectContaining({ name: 'SecurityError', message: 'WebSocket refused by the sandbox: sealed mode opens no WebSocket (it has no network)' }));
        expect(reports()).toEqual([expect.objectContaining({ type: 'VIOLATION', directive: 'connect-src', sourceFile: GATE_SOURCE_FILE })]);
    });

    it('a URL that parses nowhere still throws the SyntaxError', () => {
        clear();
        expect(() => new WebSocket('ws://')).toThrow(expect.objectContaining({ name: 'SyntaxError', message: 'the URL does not parse' }));
    });
});
