import { test, expect } from '@playwright/test';

test('Lofi Sandbox Real Virtual Files', async ({ page }) => {
  await page.goto('http://localhost:4444/');
  await page.waitForSelector('lofi-sandbox');

  // 1. Configure sandbox with Real VFS URL
  await page.evaluate(() => {
      const s = document.querySelector('lofi-sandbox');
      s.setConfig({
          scriptUnsafe: true,
          // Point to the sub-domain served by our index.ts
          vfsUrl: 'http://virtual-files.localhost:4444'
      });
  });

  // 2. Register a virtual file
  await page.evaluate(() => {
      const s = document.querySelector('lofi-sandbox');
      // We need to implement registerFiles on LofiSandbox
      s.registerFiles({
          'hello.js': 'console.log("Hello from Real VFS"); window.parent.postMessage({type:"LOG", args:["VFS Success"]}, "*");'
      });
  });

  // 3. Inject script that loads the file
  await page.evaluate(() => {
      const s = document.querySelector('lofi-sandbox');
      s.execute(`
        const script = document.createElement('script');
        script.src = 'hello.js';
        document.body.appendChild(script);
      `);
  });

  // 4. Verify log
  const msg = await page.waitForEvent('console', m => m.text().includes('VFS Success'));
  expect(msg).toBeTruthy();
});
