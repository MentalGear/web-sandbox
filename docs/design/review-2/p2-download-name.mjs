// Probe 2 of review 2: what does a File's own name do when an embedder hands it to the browser the natural ways, and
// does any engine render an application/octet-stream blob: document instead of saving it?
//
// The File is what design 02 says GuestBytes.download() answers: type application/octet-stream, name chosen by the
// library ('report.html.download'), content an HTML document with a script.
import http from 'node:http';
import { chromium, firefox, webkit } from 'playwright';

const page = `<!doctype html><title>host</title><body><script>
window.makeFile = () => new File(['<!doctype html><title>RENDERED</title><script>document.title = "SCRIPT RAN"<\\/script><h1>guest bytes</h1>'],
  'report.html.download', { type: 'application/octet-stream' });
window.clickLink = (downloadAttr) => {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(makeFile());
  if (downloadAttr !== null) a.download = downloadAttr;
  document.body.append(a); a.click();
};
</script>`;

const server = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(page); });
await new Promise((r) => server.listen(24821, '127.0.0.1', r));

const cases = [
  ['a.download = "" (empty attribute)', (p) => p.evaluate(() => clickLink(''))],
  ['a.download = file.name', (p) => p.evaluate(() => clickLink(makeFile().name))],
  ['a.download = "report.html" (the guest path, the natural wrong name)', (p) => p.evaluate(() => clickLink('report.html'))],
  ['no download attribute, same-tab link', (p) => p.evaluate(() => clickLink(null))],
  ['window.open(blob URL)', (p) => p.evaluate(() => window.open(URL.createObjectURL(makeFile())))],
];

for (const [name, type] of [['chromium', chromium], ['firefox', firefox], ['webkit', webkit]]) {
  for (const [label, act] of cases) {
    const browser = await type.launch();
    const context = await browser.newContext({ acceptDownloads: true });
    const p = await context.newPage();
    await p.goto('http://127.0.0.1:24821/');
    const download = p.waitForEvent('download', { timeout: 3000 }).then((d) => `download, suggested name ${JSON.stringify(d.suggestedFilename())}`).catch(() => null);
    const popup = context.waitForEvent('page', { timeout: 3000 }).catch(() => null);
    await act(p).catch((e) => console.log('act error', e.message));
    let outcome = await download;
    const pop = await popup;
    const titles = [];
    for (const q of context.pages()) titles.push(await q.title().catch(() => '?'));
    if (!outcome) outcome = 'no download';
    console.log(`${name.padEnd(8)} | ${label.padEnd(62)} | ${outcome} | page titles now: ${JSON.stringify(titles)}${pop ? ' (a new page opened)' : ''}`);
    await browser.close();
  }
}
server.close();
