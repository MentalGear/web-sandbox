import { test, expect } from '@playwright/test';

test('CSP Bypass via Nested Iframe - Mitigated', async ({ page }) => {
  await page.goto('http://localhost:3333/playground/security.html');
  await page.waitForFunction(() => window.SandboxControl !== undefined);
  await page.evaluate(() => window.SandboxControl.sandboxElement.setAttribute('script-unsafe', 'true'));
  await page.waitForTimeout(1000);

  const payload = `
    (async () => {
      // Spawn Malicious Frame with query params
      const iframe = document.createElement('iframe');
      // The server ignores query params now, so this should get default restricted CSP (self)
      iframe.src = "/inner-frame.html?allow=example.com&unsafe";
      document.body.appendChild(iframe);
      await new Promise(r => iframe.onload = r);

      const child = iframe.contentWindow;
      const script = child.document.createElement('script');
      script.textContent = \`
          fetch('http://example.com', { mode: 'no-cors' })
             .then(r => window.top.postMessage({ type: 'PWN_SUCCESS' }, '*'))
             .catch(e => window.top.postMessage({ type: 'PWN_FAILURE' }, '*'));
      \`;
      child.document.body.appendChild(script);
    })();
  `;

  await page.evaluate((code) => {
    window.SandboxControl.execute(code);
  }, payload);

  // We expect failure (fetch blocked by CSP)
  // Or timeout (no message ever sent if script execution fails due to CSP)

  // Wait for failure message
  const result = await page.evaluate(() => {
      return new Promise(resolve => {
          window.addEventListener('message', m => {
              if (m.data.type === 'PWN_FAILURE') resolve('blocked');
              if (m.data.type === 'PWN_SUCCESS') resolve('pwned');
          });
          // Timeout
          setTimeout(() => resolve('timeout'), 5000);
      });
  });

  // It should be blocked (failure) or timeout (if script blocked)
  expect(result).not.toBe('pwned');
});
