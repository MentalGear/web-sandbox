import { test, expect } from '@playwright/test';

test('Lofi Sandbox Worker Timeout', async ({ page }) => {
  await page.goto('http://localhost:4444/');
  await page.waitForSelector('lofi-sandbox');

  await page.evaluate(() => {
      const s = document.querySelector('lofi-sandbox');
      s.setConfig({
          mode: 'worker',
          executionTimeout: 500 // 500ms timeout
      });
  });

  // Execute infinite loop
  await page.evaluate(() => {
      const s = document.querySelector('lofi-sandbox');
      s.execute('while(true) {}');
  });

  // Expect Error Log "Execution Timeout"
  const msg = await page.waitForEvent('console', m => m.text().includes('Execution Timeout'));
  expect(msg).toBeTruthy();
});
