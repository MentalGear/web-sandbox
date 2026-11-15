import { test, expect } from '../../../test/e2e/fixture';
import { fromPreset } from '../../../test/e2e/presets';

// The build with the network modes (ADR-009): this file's tests mount them. A sealed test names the default build.
test.use({ build: 'network' });

const preset = fromPreset('protocol-handler');

test('Protocol Handler Registration - Mitigated', async ({ sandbox }) => {
    await sandbox.mount(preset.rules);

    const logs = await sandbox.runUntilDone(preset.code);

    // the refusal itself (registerProtocolHandler threw or is absent), not only the absence of a success
    expect(logs.some(l => l.includes('PWN_FAILURE'))).toBe(true);
    expect(logs.some(l => l.includes('PWN_SUCCESS'))).toBe(false);
});
