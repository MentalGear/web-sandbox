import { test, expect } from '@playwright/test';
import { PRESETS } from '@src/lib/presets';

test('Session ID Exhaustion / DoS', async ({ page }) => {
  // 1. Setup
  await page.goto('http://localhost:4444/');
  await page.waitForFunction(() => window.SandboxControl !== undefined);

  // 2. Exploit: Create massive amount of sessions
  // If the server stores sessions in memory without limits, this will crash the server.

  const payload = PRESETS['session-exhaustion'].code;

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
