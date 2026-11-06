import { beforeAll, describe, expect, it } from 'vitest';
import { GATE_SOURCE_FILE } from '@src/lib/violation';
import { createGateHarness } from './request-gate-harness';

/**
 * Sealed mode's request gate refuses every WebSocket as strict mode's does (request-gate-strict.test.ts), and its refusal
 * names the guest's own mode (BD5:NEW-4): a sealed guest read "strict mode opens no WebSocket", the name of a mode it was
 * not in. Sealed mode's bootstrap is strict mode's with `sealed` and an empty list (host.ts, _getStrictWorkerSource).
 */

const gate = createGateHarness();
const { sockets, reports, clear } = gate;

beforeAll(() => gate.install([], { mode: 'strict', sealedMode: true }));

const outcome = (make: () => unknown): string => {
    try {
        make();
        return 'made';
    } catch (error) {
        return `${(error as Error).name}: ${(error as Error).message}`;
    }
};

describe('sealed mode: every WebSocket is refused, in sealed mode\'s words', () => {
    it.each([['wss://api.example/x'], ['https://api.example/x'], ['ws://localhost:3000/x']])('%s: a SecurityError that names sealed mode, one report, and the platform is never asked', (url) => {
        clear();
        expect(outcome(() => new WebSocket(url))).toBe('SecurityError: WebSocket refused by the sandbox: sealed mode opens no WebSocket (it has no network)');
        expect(sockets).toEqual([]);
        expect(reports()).toEqual([expect.objectContaining({ type: 'VIOLATION', directive: 'connect-src', sourceFile: GATE_SOURCE_FILE })]);
    });
});
