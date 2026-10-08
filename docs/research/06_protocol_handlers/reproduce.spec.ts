import { test, expect } from '../../../test/e2e/fixture';
import { PRESETS } from '@src/lib/presets';

test('Protocol Handler Registration - Mitigated', async ({ sandbox }) => {
    await sandbox.mount();

    const logs = await sandbox.runUntilDone(PRESETS['protocol-handler'].code);

    expect(logs.some(l => l.includes('PWN_SUCCESS'))).toBe(false);
});
