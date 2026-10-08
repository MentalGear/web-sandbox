import { test, expect } from '../../../test/e2e/fixture';
import { PRESETS } from '@src/lib/presets';

test('Monkey Patch Bypass - Mitigated', async ({ sandbox }) => {
    await sandbox.mount();

    const logs = await sandbox.runUntilDone(PRESETS['monkey-patch-bypass'].code);

    expect(logs.some(l => l.includes('PWN_SUCCESS'))).toBe(false);
});
