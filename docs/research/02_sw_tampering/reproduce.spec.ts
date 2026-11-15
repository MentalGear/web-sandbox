import { test, expect } from '../../../test/e2e/fixture';
import { fromPreset } from '../../../test/e2e/presets';

// The build with the network modes (ADR-009): this file's tests mount them. A sealed test names the default build.
test.use({ build: 'network' });

const preset = fromPreset('sw-tamper');

test('Service Worker Tampering - Mitigated', async ({ sandbox }) => {
    await sandbox.mount(preset.rules);

    const logs = await sandbox.runUntilDone(preset.code);

    expect(logs.some(l => l.includes('PWN_SUCCESS'))).toBe(false);
    expect(logs.some(l => l.includes('PWN_FAILURE'))).toBe(true);
});
