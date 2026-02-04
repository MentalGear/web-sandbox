import { test, expect } from '@playwright/test';

test('Data URI Navigation', async ({ page }) => {
  // 1. Setup
  await page.goto('http://localhost:3333/playground/security.html');
  await page.waitForFunction(() => window.SandboxControl !== undefined);
  await page.evaluate(() => window.SandboxControl.sandboxElement.setAttribute('script-unsafe', 'true'));
  await page.waitForTimeout(2000);

  // 2. Exploit: Attempt to navigate the TOP frame to a data URI
  // This bypasses network filters if allowed.

  const payload = `
    try {
        const dataUrl = 'data:text/html,<h1>PWNED</h1>';
        window.top.location.href = dataUrl;
        // If successful, the page unloads.
    } catch (e) {
        window.top.postMessage({ type: 'PWN_FAILURE', message: e.message }, '*');
    }
  `;

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
  expect(url).toContain('playground/security.html'); // Should NOT change

  // We can also listen for the SecurityError message from the catch block
  // But usually cross-origin access to window.top.location throws immediately if blocked.
});
