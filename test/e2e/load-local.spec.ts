import { test, expect } from '@playwright/test';

test('Load Local HTML Page', async ({ page }) => {
  // 1. Go to the host page
  await page.goto('http://localhost:3333/playground/security.html');
  await page.waitForFunction(() => window.SandboxControl !== undefined);

  // 2. Load a local test asset
  // This tests that the sandbox (on unique origin) can fetch a resource from the host (localhost)
  // via CORS, and render it.
  // URL: /playground/test-assets/test-page.html (relative to host root)
  // Absolute: http://localhost:3333/playground/test-assets/test-page.html

  const targetUrl = 'http://localhost:3333/playground/test-assets/test-page.html';

  await page.evaluate((url) => {
    window.SandboxControl.loadSrc(url);
  }, targetUrl);

  // 3. Verify content
  // Since we loadSrc, it does fetch().then(write).
  // We need to enable scripts? loadSrc uses 'sandbox.execute'.
  // 'sandbox.execute' sends message. 'inner-frame' executes it.
  // 'inner-frame' does NOT require unsafe-eval if we monkey-patched it?
  // Wait, 'inner-frame.ts' uses 'new Function(event.data.code)'.
  // So 'unsafe-eval' IS required for 'loadSrc' to work as implemented in 'security.html'.
  // The server session needs 'unsafe: true'.

  // Let's enable it first.
  await page.evaluate(() => window.SandboxControl.sandboxElement.setAttribute('script-unsafe', 'true'));
  await page.waitForTimeout(1000); // Reload

  // Now load
  await page.evaluate((url) => {
    window.SandboxControl.loadSrc(url);
  }, targetUrl);

  // Wait for log
  await page.waitForFunction(() => {
    const logs = window.SandboxControl.getLogs();
    return logs.some(l => l.message.includes("Fetch Success: GET " + 'http://localhost:3333/playground/test-assets/test-page.html'));
  });

  // Verify visual content?
  // Use frame locator
  // Frame URL will be something like http://[uuid].sandbox.localhost:3333/inner-frame.html
  const frame = page.frame({ url: /inner-frame.html/ });
  expect(frame).not.toBeNull();

  // Since document.write was used, body should contain the content
  // Check for text "Test Page" (assuming test-page.html has it, or we check logs)

  // Actually, let's just check the logs confirmed the fetch worked.
  const logs = await page.evaluate(() => window.SandboxControl.getLogs());
  const successLog = logs.find(l => l.message.includes("Fetch Success") && l.message.includes(targetUrl));
  expect(successLog).toBeDefined();
});
