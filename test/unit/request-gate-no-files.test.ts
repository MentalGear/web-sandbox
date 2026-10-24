import { beforeAll, describe, expect, it } from 'vitest';
import { connectSources } from '@src/lib/csp/csp-generator';
import { parseOrigins } from '@src/lib/csp/origins';
import { VIOLATION_EVENT_LIMIT } from '@src/lib/violation';
import { createGateHarness } from './request-gate-harness';

/**
 * The request gate of a build with no registered file (BD3:TST-3, class E-net): its list has no `blob:` source, which
 * request-gate.test.ts's list always has (a registered file puts it there). Two rules that the larger table cannot show:
 * a `blob:` URL is refused like any other origin when the policy does not list `blob:` (the browser's policy would refuse
 * it too, but the gate is the first layer and the report is its own), and the gate reports at most VIOLATION_EVENT_LIMIT
 * refusals per environment, as the bootstrap does for the browser's own: a flood of refused requests cannot post a frame
 * each, past what the host dispatches.
 */

const CONNECT = connectSources({
    origins: parseOrigins({ connect: ['https://api.example'] }, 'worker', () => {}),
    fileKinds: new Set(),
    scriptUnsafe: false,
});

const gate = createGateHarness();
const { fetched, reports, clear } = gate;

beforeAll(() => gate.install(CONNECT));

describe('a build with no registered file', () => {
    it('the gate\'s list has no blob: source', () => {
        expect(CONNECT).toEqual(['https://api.example']);
    });

    // The reports of this file's gate count together (one environment): the blob: refusal is the first, so the flood adds the rest.
    it('a blob: URL is refused like any other origin, and reported by its scheme', async () => {
        clear();
        const result = await fetch('blob:https://api.example/0b3c').then(() => 'reached', (error: Error) => error.name);
        expect(result).toBe('TypeError');
        expect(fetched).toEqual([]);
        expect(reports().map(frame => frame.blockedURI)).toEqual(['blob']);
    });

    it('past VIOLATION_EVENT_LIMIT refusals the gate posts no more reports, from fetch and from WebSocket alike', async () => {
        clear();
        for (let i = 0; i < VIOLATION_EVENT_LIMIT + 50; i++) await fetch(`https://evil.example/${i}`).catch(() => {});
        for (let i = 0; i < VIOLATION_EVENT_LIMIT + 50; i++) {
            try {
                new WebSocket(`wss://evil.example/${i}`);
            } catch {
                // refused: the report is what is counted
            }
        }
        expect(reports(), 'the blob: report before it, then the rest of the cap').toHaveLength(VIOLATION_EVENT_LIMIT - 1);
        expect(fetched).toEqual([]);
    });
});
