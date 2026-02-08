import { test, expect } from '@playwright/test';

test('Base Tag Hijacking', async ({ page }) => {
  await page.goto('http://localhost:4444/security');
  await page.waitForFunction(() => window.SandboxControl !== undefined);
  await page.evaluate(() => {
    return new Promise(resolve => {
        window.SandboxControl.sandboxElement.addEventListener('ready', resolve, { once: true });
        window.SandboxControl.setConfig({ scriptUnsafe: true });
    });
  });

  // Exploit: Inject <base> tag and try relative fetch
  // If base-uri is missing, this might resolve 'foo' to 'https://google.com/foo'
  // But CSP connect-src should still block it if it's not allowed.

  const payload = `
    try {
        const base = document.createElement('base');
        base.href = 'https://google.com';
        document.head.appendChild(base);

        // Fetch relative URL 'foo' -> 'https://google.com/foo'
        fetch('foo', { mode: 'no-cors' })
            .then(() => console.log('PWN_SUCCESS'))
            .catch(e => console.log('PWN_FAILURE: ' + e.message));

    } catch (e) {
        console.log('PWN_FAILURE: ' + e.message);
    }
    setTimeout(() => console.log('TEST_DONE'), 2000);
  `;

  await page.evaluate((code) => {
    window.SandboxControl.execute(code);
  }, payload);

  await page.waitForFunction(() => {
    const logs = window.SandboxControl.getLogs();
    return logs.some(l => l.message.includes('TEST_DONE'));
  });

  const logs = await page.evaluate(() => window.SandboxControl.getLogs());
  const connected = logs.some(l => l.message.includes('PWN_SUCCESS'));

  // Should be blocked
  expect(connected).toBe(false);
});
