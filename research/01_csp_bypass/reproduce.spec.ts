import { test, expect } from '@playwright/test';
import { PRESETS } from '../../src/lib/presets';

test('CSP Bypass via Nested Iframe - Mitigated', async ({ page }) => {
  await page.goto('http://localhost:4444/security');
  await page.waitForSelector('lofi-sandbox');
  await page.evaluate(() => {
      const s = document.querySelector('lofi-sandbox');
      return new Promise(resolve => {
          s.addEventListener('ready', resolve, { once: true });
          s.setConfig({ scriptUnsafe: true });
      });
  });

  const payload = PRESETS['csp-bypass'].code;

  // Wait for sandbox to be ready before executing code
  // The execute method might be called before the iframe is fully loaded if we don't wait?
  // We already waited for 'ready' event when setting config.
  // But let's add a small delay or ensure we are using the helper correctly.

  // Wait for 1 second to ensure ready state before execution
  // The 'ready' event listener in the first evaluate block might resolve before we call execute,
  // but let's be super safe and wait a bit after setting config.
  await page.waitForTimeout(1000);

  // Debug: Ensure iframe is actually loaded and ready
  await page.evaluate(() => {
      const s = document.querySelector('lofi-sandbox');
      const iframe = s.shadowRoot.querySelector('iframe');
      if (!iframe) console.log("Host: No iframe found");
      else if (!iframe.contentWindow) console.log("Host: No contentWindow");
      else console.log("Host: Iframe appears ready");
  });

  await page.evaluate((code) => {
    const s = document.querySelector('lofi-sandbox');
    s.execute(code);
  }, payload);

  // 1. Wait for completion signal (Heartbeat) - ensures code ran
  await page.waitForFunction(() => {
    const logs = window.SandboxControl.getLogs();
    return logs.some(l => l.message.includes('TEST_DONE') || l.message.includes('PWN_SUCCESS') || l.message.includes('PWN_FAILURE'));
  });

  const logs = await page.evaluate(() => window.SandboxControl.getLogs());

  // Verify
  expect(logs.some(l => l.message.includes('PWN_SUCCESS'))).toBe(false);
});
