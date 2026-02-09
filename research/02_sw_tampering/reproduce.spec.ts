import { test, expect } from '@playwright/test';
import { PRESETS } from '../../src/lib/presets';

test('Service Worker Tampering - Mitigated', async ({ page }) => {
  await page.goto('http://localhost:4444/');
  await page.waitForSelector('lofi-sandbox');
  await page.evaluate(() => {
      const s = document.querySelector('lofi-sandbox');
      return new Promise(resolve => {
          s.addEventListener('ready', resolve, { once: true });
          s.setConfig({ scriptUnsafe: true });
      });
  });

  const payload = PRESETS['sw-tamper'].code;

  await page.waitForTimeout(1000);

  await page.evaluate((code) => {
    const s = document.querySelector('lofi-sandbox');
    s.execute(code);
  }, payload);

  await page.waitForFunction(() => {
    const logs = window.SandboxControl.getLogs();
    return logs.some(l => l.message.includes('TEST_DONE') || l.message.includes('PWN_SUCCESS') || l.message.includes('PWN_FAILURE'));
  });

  const logs = await page.evaluate(() => window.SandboxControl.getLogs());

  expect(logs.some(l => l.message.includes('PWN_SUCCESS'))).toBe(false);
  expect(logs.some(l => l.message.includes('PWN_FAILURE') || l.message.includes('SecurityError') || l.message.includes('No SW API'))).toBe(true);
});
