import { test, expect } from '@playwright/test';

test('Service Worker Tampering - Mitigated', async ({ page }) => {
  await page.goto('http://localhost:3333/playground/security.html');
  await page.waitForFunction(() => window.SandboxControl !== undefined);
  await page.evaluate(() => window.SandboxControl.sandboxElement.setAttribute('script-unsafe', 'true'));
  await page.waitForTimeout(1000);

  // Exploit: Try to access service worker
  const payload = `
    (async () => {
      try {
        if (!navigator.serviceWorker) {
             window.top.postMessage({ type: 'PWN_FAILURE', message: 'No SW API' }, '*');
             return;
        }
        const regs = await navigator.serviceWorker.getRegistrations();
        if (regs.length === 0) {
             window.top.postMessage({ type: 'PWN_FAILURE', message: 'No Registrations' }, '*');
        } else {
             window.top.postMessage({ type: 'PWN_SUCCESS', message: 'Found SW' }, '*');
        }
      } catch (e) {
        window.top.postMessage({ type: 'PWN_FAILURE', message: e.message }, '*');
      }
    })();
  `;

  await page.evaluate((code) => {
    window.SandboxControl.execute(code);
  }, payload);

  const result = await page.evaluate(() => {
      return new Promise(resolve => {
          window.addEventListener('message', m => {
              if (m.data.type === 'PWN_FAILURE' || m.data.type === 'PWN_SUCCESS') resolve(m.data);
          });
      });
  });

  // We expect FAILURE because there is no SW registered on the unique origin
  expect(result.type).toBe('PWN_FAILURE');
});
