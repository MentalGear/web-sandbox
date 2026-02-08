import { test, expect } from '@playwright/test';

test('Session ID Exhaustion / DoS', async ({ page }) => {
  // 1. Setup
  await page.goto('http://localhost:4444/security');
  await page.waitForFunction(() => window.SandboxControl !== undefined);

  // 2. Exploit: Create massive amount of sessions
  // If the server stores sessions in memory without limits, this will crash the server.

  const payload = `
    (async () => {
        const start = Date.now();
        let count = 0;
        try {
            while (Date.now() - start < 5000) { // Run for 5 seconds
                await fetch('/api/session', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ allow: 'google.com' })
                });
                count++;
            }
            console.log('PWN_INFO: Created ' + count + ' sessions');
        } catch (e) {
            console.log('ERROR: ' + e.message);
        }
        console.log('TEST_DONE');
    })();
  `;

  // Note: We need to enable scripts to run this loop
  await page.evaluate(() => {
    return new Promise(resolve => {
        window.SandboxControl.sandboxElement.addEventListener('ready', resolve, { once: true });
        window.SandboxControl.setConfig({ scriptUnsafe: true });
    });
  });

  await page.evaluate((code) => {
    window.SandboxControl.execute(code);
  }, payload);

  // 3. Verify: Check if server is still responsive
  // This is a "Research" finding: The new architecture introduces state on the server.
  // Is there a cleanup mechanism? Rate limit?
});
