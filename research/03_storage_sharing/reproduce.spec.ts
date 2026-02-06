import { test, expect } from '@playwright/test';

test('Storage Sharing Between Instances - Mitigated', async ({ page }) => {
  await page.goto('http://localhost:4444/');
  await page.waitForSelector('lofi-sandbox');
  await page.evaluate(() => {
      const s = document.querySelector('lofi-sandbox');
      s.setConfig({ scriptUnsafe: true });
  });

  // 1. Write
  await page.evaluate(() => {
    const s = document.querySelector('lofi-sandbox');
    s.execute(`
        try {
            localStorage.setItem('SECRET', '123');
            window.parent.postMessage({type:'LOG', args:['Write Done']}, '*');
        } catch(e) {
            window.parent.postMessage({type:'LOG', args:['Write Failed']}, '*');
        }
    `);
  });

  await page.waitForEvent('console', m => m.text().includes('Write'));

  // 2. Reload
  await page.reload();
  await page.waitForSelector('lofi-sandbox');
  await page.evaluate(() => {
      const s = document.querySelector('lofi-sandbox');
      s.setConfig({ scriptUnsafe: true });
  });

  // 3. Read
  await page.evaluate(() => {
    const s = document.querySelector('lofi-sandbox');
    s.execute(`
        const val = localStorage.getItem('SECRET');
        window.parent.postMessage({type:'LOG', args:['Read: ' + val]}, '*');
        window.parent.postMessage({type:'LOG', args:['TEST_DONE']}, '*');
    `);
  });

  const logs: string[] = [];
  page.on('console', msg => logs.push(msg.text()));
  await page.waitForEvent('console', m => m.text().includes('TEST_DONE'));

  const readLog = logs.find(l => l.includes('Read:'));
  expect(readLog).toContain('Read: null');
});
