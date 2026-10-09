import { chromium } from '/home/user/web-sandbox/node_modules/playwright/index.mjs';
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const TARGET = 'http://localhost:4444/playground/test-assets/local-image.svg';
const IMG = `<img id="x" src="${TARGET}">`;

const SHAPES = {
  'template branch (no <html>)': IMG,
  'well-formed <head>':          `<html><head><title>t</title></head><body>${IMG}</body></html>`,
  '<head lang="en">':            `<html><head lang="en"><title>t</title></head><body>${IMG}</body></html>`,
};

for (const [label, html] of Object.entries(SHAPES)) {
  let escaped = 0, frames = new Set();
  for (let i = 0; i < 5; i++) {
    const page = await browser.newPage();
    page.on('request', r => { if (r.url() === TARGET) { escaped++; frames.add(r.frame()?.url() ?? '?'); } });
    await page.goto('http://localhost:4444/playground/index.html');
    await page.waitForSelector('lofi-sandbox');
    await page.evaluate((h) => {
      const s = document.querySelector('lofi-sandbox');
      s.setConfig({ capabilities: ['allow-scripts'] });
      s.load(h);
    }, html);
    await page.waitForTimeout(2000);
    await page.close();
  }
  console.log(`${label.padEnd(30)} requests that reached the network: ${escaped}/5 runs   frames: ${[...frames].join(',') || '—'}`);
}
await browser.close();
