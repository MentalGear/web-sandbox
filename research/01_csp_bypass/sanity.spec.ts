import { test, expect } from '@playwright/test';

test('Basic Sandbox Interaction & Logging', async ({ page }) => {
  // 1. Go to the host page
  await page.goto('http://localhost:3333/playground/security.html');
  await page.waitForFunction(() => window.SandboxControl !== undefined);

  // 2. Clear logs
  await page.evaluate(() => window.SandboxControl.clearLogs());

  // 3. Console Logging (via proxy)
  await page.evaluate(() => {
    window.SandboxControl.execute('console.log("Hello from Sandbox")');
  });

  await page.waitForFunction(() => {
    const logs = window.SandboxControl.getLogs();
    return logs.some(l => l.message.includes("Hello from Sandbox"));
  });

  // 4. Network Logging (via monkey-patch)
  // We need to enable unsafe scripts first to run fetch code?
  // No, execute() runs code. But does fetch() work?
  // The default CSP connects to 'self'.
  // Let's try to fetch 'inner-frame.html' (self).

  await page.evaluate(() => {
    window.SandboxControl.execute(`
        fetch('inner-frame.html').then(r => console.log('Fetch Done: ' + r.status));
    `);
  });

  // Check for the "Fetch: GET ..." log
  await page.waitForFunction(() => {
      const logs = window.SandboxControl.getLogs();
      return logs.some(l => l.message.includes("Fetch: GET"));
  });

  const logs = await page.evaluate(() => window.SandboxControl.getLogs());
  const fetchLog = logs.find(l => l.message.includes("Fetch: GET"));
  expect(fetchLog).toBeDefined();
  console.log("Found network log:", fetchLog);
});
