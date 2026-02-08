import { test, expect } from '@playwright/test';
import { PRESETS } from '../../src/lib/presets';

test('Data URI Navigation', async ({ page }) => {
  // 1. Setup
  await page.goto('http://localhost:4444/security');
  await page.waitForFunction(() => window.SandboxControl !== undefined);
  await page.evaluate(() => {
    return new Promise(resolve => {
        window.SandboxControl.sandboxElement.addEventListener('ready', resolve, { once: true });
        window.SandboxControl.setConfig({ scriptUnsafe: true });
    });
  });

  // 2. Exploit: Attempt to navigate the TOP frame to a data URI
  // This bypasses network filters if allowed.

  const payload = PRESETS['data-uri'].code;

  await page.evaluate((code) => {
    window.SandboxControl.execute(code);
  }, payload);

  // Check if we navigated away
  try {
      // If navigation happened, this might fail or return true.
      // But sandbox usually blocks top navigation.
      const msg = await page.waitForEvent('console', { timeout: 2000 });
      // If we see error, we are good.
  } catch (e) {
      // Timeout means no console error, but maybe no navigation either.
  }

  // Check URL
  const url = page.url();
  console.log("Current URL:", url);
  expect(url).toContain('/security'); // Should NOT change

  // We can also listen for the SecurityError message from the catch block
  // But usually cross-origin access to window.top.location throws immediately if blocked.
});
