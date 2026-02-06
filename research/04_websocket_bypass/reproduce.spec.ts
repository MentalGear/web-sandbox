import { test, expect } from '@playwright/test';

test('WebSocket Bypass - Mitigated', async ({ page }) => {
  await page.goto('http://localhost:4444/');
  await page.waitForSelector('lofi-sandbox');
  await page.evaluate(() => {
      const s = document.querySelector('lofi-sandbox');
      s.setConfig({ scriptUnsafe: true });
  });

  const payload = `
    try {
        const ws = new WebSocket('wss://echo.websocket.events');
        ws.onopen = () => window.parent.postMessage({type:'LOG', args:['PWN_SUCCESS']}, '*');
        ws.onerror = () => window.parent.postMessage({type:'LOG', args:['PWN_FAILURE']}, '*');
    } catch(e) {
        window.parent.postMessage({type:'LOG', args:['PWN_FAILURE']}, '*');
    }
    setTimeout(() => window.parent.postMessage({type:'LOG', args:['TEST_DONE']}, '*'), 1000);
  `;

  await page.evaluate((code) => {
    const s = document.querySelector('lofi-sandbox');
    s.execute(code);
  });

  const logs: string[] = [];
  page.on('console', msg => logs.push(msg.text()));
  await page.waitForEvent('console', m => m.text().includes('TEST_DONE'));

  expect(logs.some(l => l.includes('PWN_SUCCESS'))).toBe(false);
});
