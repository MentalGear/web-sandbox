import { test, expect, HARNESS } from '../../../test/e2e/fixture';
import { fromPreset } from '../../../test/e2e/presets';

const preset = fromPreset('data-uri');

test('Data URI Navigation - Mitigated', async ({ sandbox, page }) => {
    await sandbox.mount(preset.rules);

    // tries to navigate the top window to a data: URI
    const logs = await sandbox.runUntilDone(preset.code);
    await page.waitForTimeout(500);

    expect(page.url()).toBe(HARNESS);
    expect(logs.some(l => l.includes('PWN_FAILURE'))).toBe(true);
});
