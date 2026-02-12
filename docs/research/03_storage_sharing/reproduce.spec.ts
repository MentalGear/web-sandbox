import { test, expect } from '@playwright/test';
import { PRESETS } from '@src/lib/presets';

test('Storage Sharing Between Instances - Mitigated', async ({ page }) => {
  await page.goto('http://localhost:4444/');
  await page.waitForSelector('lofi-sandbox');
  await page.evaluate(() => {
      const s = document.querySelector('lofi-sandbox');
      return new Promise(resolve => {
          s.addEventListener('ready', resolve, { once: true });
          s.setConfig({ scriptUnsafe: true });
      });
  });

  // 1. Write
  await page.evaluate(() => {
    const s = document.querySelector('lofi-sandbox');
    // Using custom code here as the preset combines both steps
    s.execute(`
        try {
            localStorage.setItem('SECRET', '123');
            console.log('Write Done');
        } catch(e) {
            console.log('Write Failed');
        }
    `);
  });

  await page.waitForFunction(() => {
    const logs = window.SandboxControl.getLogs();
    return logs.some(l => l.message.includes('Write'));
  });

  // 2. Reload
  await page.reload();
  await page.waitForSelector('lofi-sandbox');
  await page.evaluate(() => {
      const s = document.querySelector('lofi-sandbox');
      return new Promise(resolve => {
          s.addEventListener('ready', resolve, { once: true });
          s.setConfig({ scriptUnsafe: true });
      });
  });

  // 3. Read
  await page.evaluate(() => {
    const s = document.querySelector('lofi-sandbox');
    s.execute(`
        try {
            const val = localStorage.getItem('SECRET');
            console.log('Read: ' + val);
        } catch(e) {
            console.log('Read Failed');
        }
        console.log('TEST_DONE');
    `);
  });

  await page.waitForFunction(() => {
    const logs = window.SandboxControl.getLogs();
    return logs.some(l => l.message.includes('TEST_DONE'));
  });

  const logs = await page.evaluate(() => window.SandboxControl.getLogs());
  const readLog = logs.find(l => l.message.includes('Read:') || l.message.includes('Read Failed'));
  // If we read something, it should be null (fresh storage) or we failed to read (security error).
  // We definitely shouldn't see '123' (the secret from step 1).
  if (readLog.message.includes('Read:')) {
      expect(readLog.message).not.toContain('123');
  } else {
      expect(readLog.message).toContain('Read Failed');
  }
});
