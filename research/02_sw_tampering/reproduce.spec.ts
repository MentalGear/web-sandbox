import { test, expect } from '@playwright/test';

test('Service Worker Tampering - Mitigated', async ({ page }) => {
  await page.goto('http://localhost:4444/security');
  await page.waitForSelector('lofi-sandbox');
  await page.evaluate(() => {
      const s = document.querySelector('lofi-sandbox');
      s.setConfig({ scriptUnsafe: true });
  });

  const payload = `
    if (!navigator.serviceWorker) {
         window.parent.postMessage({ type: 'LOG', args: ['PWN_FAILURE'] }, '*');
    } else {
         window.parent.postMessage({ type: 'LOG', args: ['PWN_SUCCESS'] }, '*');
    }
    setTimeout(() => window.parent.postMessage({ type: 'LOG', args: ['TEST_DONE'] }, '*'), 100);
  `;

  await page.evaluate((code) => {
    const s = document.querySelector('lofi-sandbox');
    s.execute(code);
  });

  const logs: string[] = [];
  page.on('console', msg => logs.push(msg.text()));
  await page.waitForEvent('console', m => m.text().includes('TEST_DONE'));

  expect(logs.some(l => l.includes('PWN_SUCCESS'))).toBe(false);
  expect(logs.some(l => l.includes('PWN_FAILURE') || l.includes('SecurityError') || l.includes('No SW API'))).toBe(true); // Optional positive confirmation
});
