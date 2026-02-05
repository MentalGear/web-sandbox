import { test, expect } from '@playwright/test';

test('Storage Sharing Between Instances - Mitigated', async ({ page }) => {
  await page.goto('http://localhost:3333/playground/security.html');
  await page.waitForFunction(() => window.SandboxControl !== undefined);
  await page.evaluate(() => window.SandboxControl.sandboxElement.setAttribute('script-unsafe', 'true'));
  await page.waitForTimeout(1000);

  // 1. Write in Session A
  const writePayload = `
    localStorage.setItem('SECRET_KEY', 'my-super-secret-123');
    window.top.postMessage({ type: 'PWN_WRITE_DONE' }, '*');
  `;

  await page.evaluate((code) => {
    window.SandboxControl.execute(code);
  }, writePayload);

  await page.waitForFunction(() => {
      return new Promise(resolve => {
          window.addEventListener('message', m => {
              if (m.data.type === 'PWN_WRITE_DONE') resolve(true);
          });
      });
  });

  // 2. Reset (New Session -> New Unique Origin)
  await page.evaluate(() => window.SandboxControl.reset()); // Reset creates new session
  await page.waitForTimeout(2000);

  // 3. Read in Session B
  const readPayload = `
    const secret = localStorage.getItem('SECRET_KEY');
    window.top.postMessage({ type: 'PWN_READ_RESULT', secret }, '*');
  `;

  await page.evaluate((code) => {
    window.SandboxControl.execute(code);
  }, readPayload);

  const result = await page.evaluate(() => {
      return new Promise(resolve => {
          window.addEventListener('message', m => {
              if (m.data.type === 'PWN_READ_RESULT') resolve(m.data);
          });
      });
  });

  // Expect NULL because Session B is a different origin
  expect(result.secret).toBeNull();
});
