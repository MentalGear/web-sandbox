// Probe 2b of review 3: the two names Chromium did not download in probe 2 (`.png.download`, `x.exe~.download`), each in a
// fresh context and with a longer wait, beside a name it did download (control), five times each.
//
// Run: PLAYWRIGHT_BROWSERS_PATH=/home/user/.cache/pw-project bun docs/design/review-3/p2b-chromium-no-download.mjs
import http from 'node:http';
import { chromium } from 'playwright';
import { savedName } from '../../../src/lib/guest-bytes.ts';

const page = `<!doctype html><title>host</title><body><script>
window.saveAs = (name) => {
  const url = URL.createObjectURL(new Blob([new Uint8Array([60, 104, 49, 62])], { type: 'application/octet-stream' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
};
</script>`;
const server = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(page); });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const ORIGIN = `http://127.0.0.1:${server.address().port}/`;

const browser = await chromium.launch();
for (const path of ['.png', 'x.exe~', 'x.exe', '.env', 'x~', 'x.txt~']) {
    const outcomes = [];
    for (let run = 0; run < 5; run++) {
        const context = await browser.newContext({ acceptDownloads: true });
        const p = await context.newPage();
        await p.goto(ORIGIN);
        const download = p.waitForEvent('download', { timeout: 8000 }).catch(() => null);
        await p.evaluate((n) => saveAs(n), savedName(path));
        const got = await download;
        outcomes.push(got ? JSON.stringify(got.suggestedFilename()) : 'no download');
        await context.close();
    }
    console.log(`chromium | path ${JSON.stringify(path).padEnd(10)} | library ${JSON.stringify(savedName(path)).padEnd(20)} | ${outcomes.join(', ')}`);
}
await browser.close();
server.close();
