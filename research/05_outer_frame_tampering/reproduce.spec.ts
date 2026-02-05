import { test, expect } from '@playwright/test';

test('Outer Frame DOM Tampering - Mitigated', async ({ page }) => {
  await page.goto('http://localhost:3333/playground/security.html');
  await page.waitForFunction(() => window.SandboxControl !== undefined);
  await page.evaluate(() => window.SandboxControl.sandboxElement.setAttribute('script-unsafe', 'true'));
  await page.waitForTimeout(1000);

  // Exploit: Access window.parent.document
  // Inner Frame is uuid.sandbox.localhost
  // Outer Frame (Host) is localhost:3333
  // They are Cross-Origin. Access should throw.

  const payload = `
    try {
        const doc = window.parent.document;
        window.top.postMessage({ type: 'PWN_SUCCESS' }, '*');
    } catch (e) {
        window.top.postMessage({ type: 'PWN_FAILURE', message: e.message }, '*');
    }
  `;

  await page.evaluate((code) => {
    window.SandboxControl.execute(code);
  }, payload);

  const result = await page.evaluate(() => {
      return new Promise(resolve => {
          window.addEventListener('message', m => {
              if (m.data.type === 'PWN_SUCCESS') resolve('access');
              if (m.data.type === 'PWN_FAILURE') resolve('blocked');
          });
      });
  });

  // Expect BLOCKED (SecurityError)
  expect(result).toBe('blocked');
});
