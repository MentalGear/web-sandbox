import { test, expect } from '@playwright/test';

test('Lofi Sandbox Basic Execution', async ({ page }) => {
  await page.goto('http://localhost:4444/');

  // Wait for custom element
  await page.waitForSelector('lofi-sandbox');

  // Set config (enable scripts)
  await page.evaluate(() => {
      const s = document.querySelector('lofi-sandbox');
      s.setConfig({ scriptUnsafe: true });
  });

  // Execute code
  await page.evaluate(() => {
      const s = document.querySelector('lofi-sandbox');
      s.execute('console.log("Hello Lofi");');
  });

  // Listen for console log from sandbox (proxy)
  const msg = await page.waitForEvent('console', m => m.text().includes('Hello Lofi'));
  expect(msg).toBeTruthy();
});
