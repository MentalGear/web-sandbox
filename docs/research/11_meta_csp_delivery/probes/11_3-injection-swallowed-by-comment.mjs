import { chromium } from '/home/user/web-sandbox/node_modules/playwright/index.mjs';
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const TARGET = 'http://localhost:4444/playground/test-assets/local-image.svg';

// payload: a comment containing "<head>" swallows the injected security block,
// then a script reports what survived.
const html = `<html><body><!-- <head> -->
<script>
  const meta = document.querySelector('meta[http-equiv="Content-Security-Policy"]');
  fetch('${TARGET}')
    .then(() => parent.postMessage({csp: !!meta, fetch: 'SUCCEEDED'}, '*'))
    .catch(e => parent.postMessage({csp: !!meta, fetch: 'blocked: ' + e.message}, '*'));
</script></body></html>`;

const page = await browser.newPage();
let netHit = 0;
page.on('response', r => { if (r.url() === TARGET) netHit++; });
await page.goto('http://localhost:4444/playground/index.html');
await page.waitForSelector('lofi-sandbox');
const result = await page.evaluate(async (h) => {
  return await new Promise(resolve => {
    const handler = e => { if (e.data && 'csp' in e.data) { window.removeEventListener('message', handler); resolve(e.data); } };
    window.addEventListener('message', handler);
    const s = document.querySelector('lofi-sandbox');
    s.setConfig({ capabilities: ['allow-scripts'] });
    s.load(h);
    setTimeout(() => resolve({timeout: true}), 5000);
  });
}, html);
console.log('inside the sandbox ->', JSON.stringify(result));
console.log('network responses for the blocked asset:', netHit);
await browser.close();
