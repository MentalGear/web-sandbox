import { test, expect } from '@playwright/test';

test('Lofi Sandbox Local HTML Asset Loading', async ({ page }) => {
  await page.goto('http://localhost:4444/security');
  await page.waitForSelector('lofi-sandbox');

  // Configure sandbox to allow localhost:4444 (for fetching assets)
  await page.evaluate(() => {
      const s = document.querySelector('lofi-sandbox');
      s.setConfig({
          allow: ['http://localhost:4444'], // Allow fetching from test server
          scriptUnsafe: true
      });
  });

  // Create a dummy asset on the server?
  // Our server serves /src/.
  // Let's try to fetch /src/host.ts (it exists)

  await page.evaluate(() => {
      const s = document.querySelector('lofi-sandbox');
      s.execute(`
        fetch('http://localhost:4444/src/host.ts')
            .then(r => r.text())
            .then(t => {
                // Check content
                if (t.includes('LofiSandbox')) {
                    // Send success via port (Host listens to sandbox-log)
                    // Wait, our 'execute' wrapper in test doesn't easily hook into the port.
                    // But 'host.ts' relays LOG messages to window event 'sandbox-log'.
                    // And our bootstrapper sends console logs to port.
                    console.log('Asset Loaded Success');
                } else {
                    console.error('Asset Content Mismatch');
                }
            })
            .catch(e => console.error('Asset Fetch Failed: ' + e.message));
      `);
  });

  // Verify log
  const msg = await page.waitForEvent('console', m => m.text().includes('Asset Loaded Success'));
  expect(msg).toBeTruthy();
});
