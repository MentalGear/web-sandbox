import { test, expect } from '../../../test/e2e/fixture';
import { PRESETS } from '@src/lib/presets';

test('WebSocket Bypass - Mitigated', async ({ sandbox }) => {
    await sandbox.mount();

    const logs = await sandbox.runUntilDone(PRESETS['websocket-bypass'].code);

    expect(logs.some(l => l.includes('PWN_SUCCESS'))).toBe(false);
});
