import { test, expect } from '@playwright/test';

test('Outer Frame DOM Tampering - Mitigated', async ({ page }) => {
  page.on('console', msg => console.log(msg.text()));
  await page.goto('http://localhost:4444/security');
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

  const payload = `
    try {
        const p = window.parent.document;
        console.log('PWN_SUCCESS');
    } catch(e) {
        console.log('PWN_FAILURE');
    }
    setTimeout(() => console.log('TEST_DONE'), 100);
  `;

  await page.evaluate((code) => {
    const s = document.querySelector('lofi-sandbox');
    s.execute(code);
  }, payload);

  try {
    await page.waitForFunction(() => {
        const logs = window.SandboxControl.getLogs();
        return logs.some(l => l.message.includes('TEST_DONE'));
    }, { timeout: 5000 });
  } catch (e) {
    const logs = await page.evaluate(() => {
        console.log("Debug: Getting logs...");
        return window.SandboxControl.getLogs();
    });
    console.log("Current Logs:", JSON.stringify(logs, null, 2));
    throw e;
  }

  const logs = await page.evaluate(() => window.SandboxControl.getLogs());

  expect(logs.some(l => l.message.includes('PWN_SUCCESS'))).toBe(false);
});
