import { test, expect } from './fixture';

test('terminates a worker that exceeds workerExecutionTimeout, then recovers', async ({ sandbox, page }) => {
    await sandbox.mount({ mode: 'worker', workerExecutionTimeout: 500 });

    await sandbox.run('while (true) {}');
    await sandbox.waitForLog('Execution Timeout', 5000);

    // the frame (and its worker) was recreated: a fresh sandbox accepts code again
    await page.waitForTimeout(500);
    await sandbox.run('console.log("alive after timeout")');
    expect(await sandbox.waitForLog('alive after timeout')).toBeTruthy();
});
