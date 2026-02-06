import { test, expect } from '@playwright/test';

test('CSP Bypass via Nested Iframe - Mitigated', async ({ page }) => {
  await page.goto('http://localhost:4444/');
  await page.waitForSelector('lofi-sandbox');
  await page.evaluate(() => {
      const s = document.querySelector('lofi-sandbox');
      s.setConfig({ scriptUnsafe: true });
  });

  const payload = `
    (async () => {
      try {
          const iframe = document.createElement('iframe');
          iframe.src = "javascript:alert(1)";
          document.body.appendChild(iframe);

          iframe.onload = () => window.parent.postMessage({type:'LOG', args:['PWN_SUCCESS']}, '*');
          iframe.onerror = () => window.parent.postMessage({type:'LOG', args:['PWN_FAILURE']}, '*');

          // Wait a bit for async load
          setTimeout(() => {
              window.parent.postMessage({type:'LOG', args:['TEST_DONE']}, '*');
          }, 500);
      } catch (e) {
          window.parent.postMessage({type:'LOG', args:['TEST_DONE']}, '*');
      }
    })();
  `;

  await page.evaluate((code) => {
    const s = document.querySelector('lofi-sandbox');
    s.execute(code);
  });

  // 1. Wait for completion signal (Heartbeat) - ensures code ran
  await page.waitForEvent('console', m => m.text().includes('TEST_DONE'));

  // 2. Assert NO success signal was logged
  // We check the *history* of logs or just ensure current state is clean.
  // Playwright's console event listener is live.
  // But we can check if we missed it? No, we started listening implicitly?
  // Better: Gather logs during execution.

  // Actually, checking history is hard in Playwright unless we buffered it.
  // But we know 'PWN_SUCCESS' would happen *before* 'TEST_DONE' in this logic?
  // Or roughly same time.
  // Let's assume if we reached TEST_DONE without crashing, and didn't see PWN_SUCCESS *yet*, we are good?
  // Risky.

  // Better:
  const logs: string[] = [];
  page.on('console', msg => logs.push(msg.text()));

  // Wait for DONE
  await page.waitForEvent('console', m => m.text().includes('TEST_DONE'));

  // Verify
  expect(logs.some(l => l.includes('PWN_SUCCESS'))).toBe(false);
});
