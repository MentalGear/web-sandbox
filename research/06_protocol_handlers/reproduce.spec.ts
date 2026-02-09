import { test, expect } from '@playwright/test';
import { PRESETS } from '../../src/lib/presets';

test('Protocol Handler Registration', async ({ page }) => {
  // 1. Setup
  await page.goto('http://localhost:4444/');
  await page.waitForFunction(() => window.SandboxControl !== undefined);
  await page.evaluate(() => {
    return new Promise(resolve => {
        window.SandboxControl.sandboxElement.addEventListener('ready', resolve, { once: true });
        window.SandboxControl.setConfig({ scriptUnsafe: true });
    });
  });

  // 2. Exploit: Attempt to register a protocol handler
  // Sandboxed iframes often block this. If it succeeds, it's a breakout (persistent OS integration).

  const payload = PRESETS['protocol-handler'].code;

  await page.evaluate((code) => {
    window.SandboxControl.execute(code);
  }, payload);

  await page.waitForFunction(() => {
    const logs = window.SandboxControl.getLogs();
    return logs.some(l => l.message.includes('TEST_DONE'));
  });

  const logs = await page.evaluate(() => window.SandboxControl.getLogs());
  const result = logs.find(l => l.message.includes('PWN_SUCCESS') || l.message.includes('PWN_FAILURE'));
  console.log("Protocol Handler Result:", result);

  // If it failed, it's good security. If it succeeded, it's a finding.
  // Usually fails with "Ignored attempt to register a protocol handler..." or "SecurityError".
});
