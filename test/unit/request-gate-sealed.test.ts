import { describe, expect, it } from 'vitest';
import { createGateHarness } from './request-gate-harness';

/**
 * The gate fails closed where it cannot remove a copy of the platform's maker (BD3:TST-3, class E-net): a `fetch` on the
 * global object's prototype chain that holds the original and cannot be deleted would leave the guest a way round the
 * gate, so the bootstrap throws before any guest code runs. A property that is not configurable is the platform breaking
 * the contract the gate relies on; no browser does, so the rule is reachable only here, over a sealed copy.
 */

describe('a copy of the platform\'s fetch that cannot be removed', () => {
    it('ends the bootstrap with a TypeError that names the maker', () => {
        const gate = createGateHarness();
        expect(() => gate.install(['https://api.example'], { sealed: true })).toThrow('[Sandbox] the request gate could not remove fetch');
    });
});
