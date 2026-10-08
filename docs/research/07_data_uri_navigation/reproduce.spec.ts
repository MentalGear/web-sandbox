import { test, expect, HARNESS } from '../../../test/e2e/fixture';
import { PRESETS } from '@src/lib/presets';

test('Data URI Navigation - Mitigated', async ({ sandbox, page }) => {
    await sandbox.mount();

    // tries to navigate the top window to a data: URI
    const logs = await sandbox.runUntilDone(PRESETS['data-uri'].code);
    await page.waitForTimeout(500);

    expect(page.url()).toBe(HARNESS);
    expect(logs.some(l => l.includes('PWN_FAILURE'))).toBe(true);
});
