import { test, expect } from '../../../test/e2e/fixture';
import { PRESETS } from '@src/lib/presets';

test('Protocol Handler Registration - Mitigated', async ({ sandbox }) => {
    await sandbox.mount();

    const logs = await sandbox.runUntilDone(PRESETS['protocol-handler'].code);

    // the refusal itself (registerProtocolHandler threw or is absent), not only the absence of a success
    expect(logs.some(l => l.includes('PWN_FAILURE'))).toBe(true);
    expect(logs.some(l => l.includes('PWN_SUCCESS'))).toBe(false);
});
