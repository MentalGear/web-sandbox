import { beforeAll, describe, expect, it } from 'vitest';
import { GATE_SOURCE_FILE } from '@src/lib/violation';
import { createGateHarness } from './request-gate-harness';

/**
 * The request gate is one of the three layers that keep a request out of a sealed guest (the others: the renderer's rules
 * for the view's markup and styles, test/unit/in-sandbox-view.test.ts, and the view's policy, test/unit/sealed-mode.test.ts
 * T3). Each is pinned in its own test (BD5:TST-4), so removing any one fails a test, instead of the other two covering
 * for it and the e2e suite not telling which one held. Here: a worker built the way sealed mode builds it, with the empty
 * gate list and the sealed feature (host.ts, _getStrictWorkerSource), refuses every request of fetch(), XMLHttpRequest and
 * WebSocket, reports each one, and never calls the platform's original. The positive control is strict mode's gate over a
 * list, in request-gate.test.ts, where the same URLs are admitted.
 */

const gate = createGateHarness();
const { fetched, opened, sent, sockets, reports, clear } = gate;

beforeAll(() => gate.install([], { mode: 'strict', sealedMode: true }));

// every kind of address a request can name: a listed-looking origin, the host's likely origin, a blob: URL (which strict
// mode's gate admits when a file needs it), other schemes
const URLS = ['https://api.example/x', 'https://localhost/x', 'http://localhost:5173/x', 'blob:https://api.example/0b3c', 'blob:null/0b3c', 'data:text/plain,x', 'about:blank'];

describe('sealed mode\'s gate admits nothing: the platform\'s fetch, XMLHttpRequest and WebSocket are never reached', () => {
    it.each(URLS)('fetch(%s) is refused and reported, and the platform\'s fetch is never called', async (url) => {
        clear();
        const result = await fetch(url).then(() => 'reached', (error: Error) => error.name);
        expect(result).toBe('TypeError');
        expect(fetched).toEqual([]);
        expect(reports(), url).toEqual([expect.objectContaining({ type: 'VIOLATION', directive: 'connect-src', sourceFile: GATE_SOURCE_FILE })]);
    });

    it.each(URLS)('XMLHttpRequest %s: send() is refused and reported, and the platform is never asked to send', (url) => {
        clear();
        const request = new XMLHttpRequest();
        request.open('GET', url);
        request.send();
        expect(opened).toEqual(['about:blank']); // a placeholder the platform is never asked to send
        expect(sent).toEqual([]);
        expect(reports(), url).toEqual([expect.objectContaining({ type: 'VIOLATION', directive: 'connect-src', sourceFile: GATE_SOURCE_FILE })]);
    });

    it.each(['wss://api.example/x', 'ws://localhost:5173/x', 'https://api.example/x'])('new WebSocket(%s) throws and the platform\'s WebSocket is never constructed', (url) => {
        clear();
        expect(() => new WebSocket(url)).toThrow();
        expect(sockets).toEqual([]);
        expect(reports()).toHaveLength(1);
    });

    it('a Request object, a URL object and a String object are refused like the text', async () => {
        clear();
        for (const input of [new Request('https://api.example/x'), new URL('https://api.example/x'), { toString: () => 'https://api.example/x' }]) {
            expect(await fetch(input as RequestInfo).then(() => 'reached', () => 'refused')).toBe('refused');
        }
        expect(fetched).toEqual([]);
        expect(reports()).toHaveLength(3);
    });
});

// BD6:NEW-1: sealed mode refuses the `origins` option, so a refusal that points at origins.connect points at nothing; it
// says what sealed mode is, and what the app can do instead.
const SEALED_REFUSAL = 'refused by the sandbox: sealed mode has no network; call a method the host page exposes instead';

describe("sealed mode's refusals name sealed mode, never an option it refuses (BD6:NEW-1)", () => {
    it('fetch() rejects with a TypeError in sealed words', async () => {
        const error = await fetch('https://api.example/x').then(() => null, (refused: Error) => refused);
        expect([error?.name, error?.message]).toEqual(['TypeError', `fetch() ${SEALED_REFUSAL}`]);
    });

    it('a synchronous XMLHttpRequest send() throws a NetworkError in sealed words', () => {
        const request = new XMLHttpRequest();
        request.open('GET', 'https://api.example/x', false);
        expect(() => request.send()).toThrow(expect.objectContaining({ name: 'NetworkError', message: `XMLHttpRequest ${SEALED_REFUSAL}` }));
    });
});
