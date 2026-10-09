import { test, expect } from '../../../test/e2e/fixture';
import { PRESETS } from '@src/lib/presets';

test('Base Tag Hijacking - Mitigated', async ({ sandbox }) => {
    await sandbox.mount();

    const logs = await sandbox.runUntilDone(PRESETS['base-tag'].code);

    expect(logs.some(l => l.includes('PWN_SUCCESS'))).toBe(false);
});
