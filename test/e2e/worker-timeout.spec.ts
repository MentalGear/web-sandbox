import { test, expect } from './fixture';
import { fromPreset } from './presets';

const preset = fromPreset('worker-timeout');

test('terminates a worker that exceeds workerExecutionTimeout, then recovers', async ({ sandbox, page }) => {
    await sandbox.mount(preset.rules);

    await sandbox.run(preset.code);
    await sandbox.waitForLog('Execution Timeout', 5000);

    // the frame (and its worker) was recreated: a fresh sandbox accepts code again
    await page.waitForTimeout(500);
    await sandbox.run('console.log("alive after timeout")');
    expect(await sandbox.waitForLog('alive after timeout')).toBeTruthy();
});
