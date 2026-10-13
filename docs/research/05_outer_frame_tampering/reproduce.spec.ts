import { test, expect } from '../../../test/e2e/fixture';
import { fromPreset } from '../../../test/e2e/presets';

const preset = fromPreset('outer-frame-tampering');

test('Outer Frame DOM Tampering - Mitigated', async ({ sandbox }) => {
    await sandbox.mount(preset.rules);

    const logs = await sandbox.runUntilDone(preset.code);

    // the refusal itself (each access threw), not only the absence of a success
    expect(logs).toContain('PWN_FAILURE parent SecurityError');
    expect(logs).toContain('PWN_FAILURE top SecurityError');
    expect(logs.some(l => l.includes('PWN_SUCCESS'))).toBe(false);
});
