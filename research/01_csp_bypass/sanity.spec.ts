import { test, expect } from '@playwright/test';

test('Basic Sandbox Interaction & Logging', async ({ page }) => {
  await page.goto('http://localhost:4444/security');
  await page.waitForFunction(() => window.SandboxControl !== undefined);

  // Need to enable unsafe-eval for 'execute' to work (new Function used in inner-frame.ts)
  // Also allow localhost for fetch test
  await page.evaluate(() => {
    return new Promise(resolve => {
        window.SandboxControl.sandboxElement.addEventListener('ready', resolve, { once: true });
        window.SandboxControl.setConfig({ scriptUnsafe: true, allow: ['localhost:4444'] });
    });
  });

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
        fetch('/security').then(r => console.log('Fetch Done: ' + r.status));
    `);
  });

  await page.waitForFunction(() => {
      const logs = window.SandboxControl.getLogs();
      return logs.some(l => l.message.includes("Fetch Done"));
  });

  const logs = await page.evaluate(() => window.SandboxControl.getLogs());
  const fetchLog = logs.find(l => l.message.includes("Fetch Done"));
  expect(fetchLog).toBeDefined();
});
