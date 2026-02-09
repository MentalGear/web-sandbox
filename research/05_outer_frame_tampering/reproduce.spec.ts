import { test, expect } from '@playwright/test';
import { PRESETS } from '../../src/lib/presets';

test('Outer Frame DOM Tampering - Mitigated', async ({ page }) => {
  page.on('console', msg => console.log(msg.text()));
  await page.goto('http://localhost:4444/');
  await page.waitForSelector('lofi-sandbox');
  console.log("Setting script-unsafe...");
  await page.evaluate(() => {
      const s = document.querySelector('lofi-sandbox');
      return new Promise(resolve => {
          s.addEventListener('ready', resolve, { once: true });
          s.setConfig({ scriptUnsafe: true });
      });
  });
  console.log("Set script-unsafe.");

  const payload = PRESETS['outer-frame-tampering'].code;

  await page.evaluate((code) => {
    const s = document.querySelector('lofi-sandbox');
    s.execute(code);
  }, payload);

  await page.waitForFunction(() => {
      const logs = window.SandboxControl.getLogs();
      return logs.some(l => l.message.includes('TEST_DONE'));
  });

  const logs = await page.evaluate(() => window.SandboxControl.getLogs());

  expect(logs.some(l => l.message.includes('PWN_SUCCESS'))).toBe(false);
});
