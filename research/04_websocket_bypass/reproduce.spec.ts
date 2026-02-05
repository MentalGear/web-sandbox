import { test, expect } from '@playwright/test';

test('WebSocket Bypass - Mitigated', async ({ page }) => {
  await page.goto('http://localhost:3333/playground/security.html');
  await page.waitForFunction(() => window.SandboxControl !== undefined);
  await page.evaluate(() => window.SandboxControl.sandboxElement.setAttribute('script-unsafe', 'true'));
  await page.waitForTimeout(1000);

  // Exploit: Try to connect via WebSocket
  // CSP should block it because our allowedOrigins only includes http/https schemes?
  // Or 'connect-src self' might allow ws://self?
  // But we are connecting to external.

  const payload = `
    (async () => {
      try {
          const ws = new WebSocket('wss://echo.websocket.events');
          ws.onopen = () => window.top.postMessage({ type: 'PWN_SUCCESS' }, '*');
          ws.onerror = () => window.top.postMessage({ type: 'PWN_FAILURE' }, '*');
      } catch (e) {
          window.top.postMessage({ type: 'PWN_FAILURE' }, '*');
      }
    })();
  `;

  await page.evaluate((code) => {
    window.SandboxControl.execute(code);
  }, payload);

  const result = await page.evaluate(() => {
      return new Promise(resolve => {
          window.addEventListener('message', m => {
              if (m.data.type === 'PWN_SUCCESS') resolve('connected');
              if (m.data.type === 'PWN_FAILURE') resolve('blocked');
              setTimeout(() => resolve('timeout'), 5000);
          });
      });
  });

  // Expect BLOCKED
  expect(result).not.toBe('connected');
});
