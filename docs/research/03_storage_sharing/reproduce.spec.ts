import { test, expect } from '../../../test/e2e/fixture';
import { fromPreset } from '../../../test/e2e/presets';

// The preset reads before it writes, so running it in two sandboxes shows whether the second can read what
// the first stored.
const preset = fromPreset('storage-sharing');

test('Storage Sharing Between Instances - Mitigated', async ({ sandbox }) => {
    // 1. Read, then write
    await sandbox.mount(preset.rules);
    const first = await sandbox.runUntilDone(preset.code);
    expect(first.find(l => l.startsWith('Write'))).toBeDefined();

    // 2. Reload the host page and start a fresh sandbox
    await sandbox.open();
    await sandbox.mount(preset.rules);

    // 3. Read again
    const logs = await sandbox.runUntilDone(preset.code);

    // Either storage is unavailable (opaque origin) or it is fresh — never the secret from step 1.
    const readLog = logs.find(l => l.startsWith('Read'));
    expect(readLog).toBeDefined();
    expect(readLog).not.toContain('123');
});
