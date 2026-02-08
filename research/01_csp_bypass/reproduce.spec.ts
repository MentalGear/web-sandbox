import { test, expect } from '@playwright/test';

test('CSP Bypass via Nested Iframe - Mitigated', async ({ page }) => {
  await page.goto('http://localhost:4444/security');
  await page.waitForSelector('lofi-sandbox');
  await page.evaluate(() => {
      const s = document.querySelector('lofi-sandbox');
      return new Promise(resolve => {
          s.addEventListener('ready', resolve, { once: true });
          s.setConfig({ scriptUnsafe: true });
      });
  });

  const payload = `
    (async () => {
      try {
          const iframe = document.createElement('iframe');
          iframe.src = "javascript:alert(1)";
          document.body.appendChild(iframe);

          iframe.onload = () => console.log('PWN_SUCCESS');
          iframe.onerror = () => console.log('PWN_FAILURE');

          // Wait a bit for async load
          setTimeout(() => {
              console.log('TEST_DONE');
          }, 500);
      } catch (e) {
          console.log('TEST_DONE');
      }
    })();
  `;

  await page.evaluate((code) => {
    const s = document.querySelector('lofi-sandbox');
    s.execute(code);
  }, payload);

  // 1. Wait for completion signal (Heartbeat) - ensures code ran
  await page.waitForFunction(() => {
    const logs = window.SandboxControl.getLogs();
    return logs.some(l => l.message.includes('TEST_DONE'));
  });

  const logs = await page.evaluate(() => window.SandboxControl.getLogs());

  // Verify
  expect(logs.some(l => l.message.includes('PWN_SUCCESS'))).toBe(false);
});
