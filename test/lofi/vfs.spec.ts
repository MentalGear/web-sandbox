import { test, expect } from '@playwright/test';

test('Lofi Sandbox VFS Loading', async ({ page }) => {
  await page.goto('http://localhost:4444/security');
  await page.waitForSelector('lofi-sandbox');

  // Configure VFS
  await page.evaluate(() => {
      const s = document.querySelector('lofi-sandbox');
      s.setConfig({
          scriptUnsafe: true,
          vfsUrl: 'http://localhost:4444/vfs'
      });
  });

  // Inject script that loads from VFS
  // Note: lofi-sandbox render() puts vfsUrl in CSP and Base URI.
  // We need to inject a <script src="main.js"> into the sandbox.
  // Since we don't have a file list API in the LofiSandbox yet (it just sets base),
  // we rely on the user code (or initial HTML) to have script tags.
  // But our 'render' method only puts a 'bootstrapper' script.
  // We can 'execute' code to create a script tag.

  await page.evaluate(() => {
      const s = document.querySelector('lofi-sandbox');
      s.execute(`
        const script = document.createElement('script');
        script.src = 'main.js'; // Resolves to vfsUrl/sessionId/main.js
        document.body.appendChild(script);
      `);
  });

  // Verify log from VFS script
  const msg = await page.waitForEvent('console', m => m.text().includes('VFS Loaded'));
  expect(msg).toBeTruthy();
});
