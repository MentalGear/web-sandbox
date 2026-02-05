import { test, expect } from '@playwright/test';

test('Basic Sandbox Interaction & Logging', async ({ page }) => {
  await page.goto('http://localhost:3333/playground/security.html');
  await page.waitForFunction(() => window.SandboxControl !== undefined);

  // Need to enable unsafe-eval for 'execute' to work (new Function used in inner-frame.ts)
  await page.evaluate(() => window.SandboxControl.sandboxElement.setAttribute('script-unsafe', 'true'));
  await page.waitForTimeout(1000);

  // Clear logs
  await page.evaluate(() => window.SandboxControl.clearLogs());

  // Console Logging
  await page.evaluate(() => {
    window.SandboxControl.execute('console.log("Hello from Sandbox")');
  });

  await page.waitForFunction(() => {
    const logs = window.SandboxControl.getLogs();
    return logs.some(l => l.message.includes("Hello from Sandbox"));
  });

  // Network Logging
  await page.evaluate(() => {
    window.SandboxControl.execute(`
        fetch('inner-frame.html').then(r => console.log('Fetch Done: ' + r.status));
    `);
  });

  await page.waitForFunction(() => {
      const logs = window.SandboxControl.getLogs();
      return logs.some(l => l.message.includes("Fetch: GET"));
  });

  const logs = await page.evaluate(() => window.SandboxControl.getLogs());
  const fetchLog = logs.find(l => l.message.includes("Fetch: GET"));
  expect(fetchLog).toBeDefined();
});
