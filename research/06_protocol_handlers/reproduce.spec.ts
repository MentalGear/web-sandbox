import { test, expect } from '@playwright/test';

test('Protocol Handler Registration', async ({ page }) => {
  // 1. Setup
  await page.goto('http://localhost:3333/playground/security.html');
  await page.waitForFunction(() => window.SandboxControl !== undefined);
  await page.evaluate(() => window.SandboxControl.sandboxElement.setAttribute('script-unsafe', 'true'));
  await page.waitForTimeout(2000);

  // 2. Exploit: Attempt to register a protocol handler
  // Sandboxed iframes often block this. If it succeeds, it's a breakout (persistent OS integration).

  const payload = `
    try {
        navigator.registerProtocolHandler('web+test', 'https://example.com?q=%s', 'Test Handler');
        window.top.postMessage({ type: 'PWN_SUCCESS', message: 'Handler Registered' }, '*');
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
              if (m.data.type === 'PWN_SUCCESS' || m.data.type === 'PWN_FAILURE') resolve(m.data);
          });
      });
  });

  // We expect FAILURE because standard sandbox attributes usually block this.
  // But we want to document the attempt.
  console.log("Protocol Handler Result:", result);

  // If it failed, it's good security. If it succeeded, it's a finding.
  // Usually fails with "Ignored attempt to register a protocol handler..." or "SecurityError".
});
