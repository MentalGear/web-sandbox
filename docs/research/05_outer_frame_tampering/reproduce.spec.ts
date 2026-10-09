import { test, expect } from '../../../test/e2e/fixture';
import { PRESETS } from '@src/lib/presets';

test('Outer Frame DOM Tampering - Mitigated', async ({ sandbox }) => {
    await sandbox.mount();

    const logs = await sandbox.runUntilDone(PRESETS['outer-frame-tampering'].code);

    expect(logs.some(l => l.includes('PWN_SUCCESS'))).toBe(false);
});
