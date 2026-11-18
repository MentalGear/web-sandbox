// Opens one page in Chromium and prints the application's result as JSON: node measure.mjs <page url> <expected sha256>.
// Run it under `flock` (the machine's browser lock); run.mjs does.
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');

// What the element does with the URL: frames it. The request is a navigation (Sec-Fetch-Dest: iframe), which a dev
// server may answer differently from the application's fetch().
async function loadAsFrame(page, url, expectedSha) {
  const framed = page.waitForResponse((response) => response.url() === url && response.request().resourceType() === 'document', { timeout: 8000 });
  await page.evaluate((src) => {
    const frame = document.createElement('iframe');
    frame.src = src;
    document.body.append(frame);
  }, url);
  try {
    const response = await framed;
    const sha256 = createHash('sha256').update(await response.body()).digest('hex');
    return { status: response.status(), contentType: response.headers()['content-type'] ?? null, sha256, bytesEqual: sha256 === expectedSha };
  } catch (error) {
    return { error: error.message.split('\n')[0] };
  }
}

const [pageUrl, expectedSha] = process.argv.slice(2);
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  const messages = [];
  page.on('console', (message) => messages.push(`${message.type()}: ${message.text()}`));
  page.on('pageerror', (error) => messages.push(`pageerror: ${error.message}`));
  await page.goto(pageUrl);
  let result;
  try {
    await page.waitForFunction(() => window.__result, null, { timeout: 15000 });
    result = await page.evaluate(() => window.__result);
  } catch (error) {
    result = { error: `no result: ${error.message.split('\n')[0]}`, body: (await page.textContent('body')).slice(0, 300) };
  }
  if (result.url?.startsWith('http')) result.iframe = await loadAsFrame(page, result.url, expectedSha);
  result.engine = `chromium ${browser.version()}`;
  result.sameOrigin = result.documentOrigin === result.appOrigin && result.scriptOrigin === result.appOrigin;
  result.is200Html = result.status === 200 && /^text\/html/i.test(result.contentType ?? '');
  result.bytesEqual = result.sha256 === expectedSha;
  // a data: URL is the file's bytes inlined into the bundle: keep its head only
  if (result.url?.startsWith('data:')) result.url = `${result.url.slice(0, 40)}... (${result.url.length} characters)`;
  result.fileName = result.url?.startsWith('http') ? new URL(result.url).pathname.split('/').pop() : null;
  result.console = messages;
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
} finally {
  await browser.close();
}
