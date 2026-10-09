import { chromium } from '/home/user/web-sandbox/node_modules/playwright/index.mjs';
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const page = await browser.newPage();
await page.goto('http://localhost:4444/playground/index.html');

const IMG = 'http://localhost:4444/playground/test-assets/local-image.svg';
const CSP = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline';">`;
const REPORT = `<script>
  const meta = document.querySelector('meta[http-equiv]');
  const img = new Image();
  img.onload  = () => parent.postMessage({loaded:true,  metaParent: meta ? meta.parentElement.tagName : 'GONE'}, '*');
  img.onerror = () => parent.postMessage({loaded:false, metaParent: meta ? meta.parentElement.tagName : 'GONE'}, '*');
  img.src = '${IMG}';
</script>`;

const CASES = {
  'A: meta first in <head> (the happy path)':
    `<!DOCTYPE html><html><head>${CSP}</head><body>${REPORT}</body></html>`,
  'B: <img> in <head> before the meta tag':
    `<!DOCTYPE html><html><head><img src="${IMG}">${CSP}</head><body>${REPORT}</body></html>`,
  'C: comment + text before the meta tag':
    `<!DOCTYPE html><html><head><!-- hi -->${CSP}</head><body>${REPORT}</body></html>`,
  'D: meta placed in <body> (what host.ts produces if <head> is absent)':
    `<!DOCTYPE html><html><head></head><body>${CSP}${REPORT}</body></html>`,
  'E: user content opens <body> early, per host.ts <html>-without-<head> branch':
    `<!DOCTYPE html><html><head>${CSP}</head><body><p>user</p>${REPORT}</body></html>`,
};

for (const [name, srcdoc] of Object.entries(CASES)) {
  const r = await page.evaluate(async (doc) => {
    return await new Promise(resolve => {
      const f = document.createElement('iframe');
      f.setAttribute('sandbox', 'allow-scripts');
      const h = e => { if (e.data && 'loaded' in e.data) { window.removeEventListener('message', h); resolve(e.data); } };
      window.addEventListener('message', h);
      f.srcdoc = doc;
      document.body.appendChild(f);
      setTimeout(() => resolve({timeout: true}), 3000);
    });
  }, srcdoc);
  const verdict = r.timeout ? 'TIMEOUT' : (r.loaded ? '!! IMAGE LOADED - policy NOT enforced' : 'blocked (policy enforced)');
  console.log(`${name}\n    -> ${verdict}   [meta ended up in: ${r.metaParent ?? 'n/a'}]`);
}
await browser.close();
