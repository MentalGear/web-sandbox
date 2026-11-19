// Probe 2 of review 3 (I9): what name each engine suggests for a file GuestBytes.save() saves, for the edge cases of a
// valid path: a name past a filesystem's 255 bytes, Windows device names, a trailing dot, a dotfile, upper case,
// characters a path may hold (`;`, `'`, `=`, `&`, `~`, `$`), extensions an OS opens by double click.
//
// The names are computed by the library's own savedName() (src/lib/guest-bytes.ts), and the save is the library's
// saveAs() step for step: an application/octet-stream blob, a link of the host page's document never inserted, its
// `download` attribute the name, one click(), the URL revoked at once. The engine's answer is Playwright's
// suggestedFilename(): the name the browser hands its download manager. What a desktop browser's download manager then
// does with it (Chromium's target determiner truncates and uniquifies; Safari's own `.download` bundles) is not in
// reach of headless engines.
//
// Run: PLAYWRIGHT_BROWSERS_PATH=/home/user/.cache/pw-project bun docs/design/review-3/p2-save-names.mjs
import http from 'node:http';
import { chromium, firefox, webkit } from 'playwright';
import { savedName } from '../../../src/lib/guest-bytes.ts';
import { isValidPath } from '../../../src/lib/files.ts';

const PATHS = [
    'a'.repeat(252) + '.exe', 'a'.repeat(247) + '.html', 'b'.repeat(251) + '.png',
    'CON.png', 'nul.txt', 'com1', 'x.exe;.png', "x'.png", 'x.png.', '..png', '.png', '.htaccess', 'x.PNG', 'x.lnk',
    'x.desktop', 'x.scr', 'x.css', 'x.json', 'x.map', 'x.ttf', 'x.svg', 'x.exe~', 'x=y&z.txt', 'x.html.', 'x.download',
    'x.$', '~$x.txt', 'x.txt;.exe', 'x.png;.html',
];
for (const path of PATHS) if (!isValidPath(path)) throw new Error(`not a valid path: ${path}`);

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
const short = (text) => (text.length > 44 ? `${text.slice(0, 6)}…(${text.length})…${text.slice(-24)}` : text);

for (const [engineName, engine] of [['chromium', chromium], ['firefox', firefox], ['webkit', webkit]]) {
    const browser = await engine.launch();
    const context = await browser.newContext({ acceptDownloads: true });
    const p = await context.newPage();
    await p.goto(ORIGIN);
    for (const path of PATHS) {
        const name = savedName(path);
        const download = p.waitForEvent('download', { timeout: 3000 }).catch(() => null);
        await p.evaluate((n) => saveAs(n), name);
        const got = await download;
        const suggested = got ? got.suggestedFilename() : null;
        const bytes = got ? await got.path().then((file) => file ? import('node:fs').then((fs) => fs.readFileSync(file).length) : -1).catch(() => -1) : -1;
        const verdict = suggested === null ? 'NO DOWNLOAD' : suggested === name ? 'as named' : 'CHANGED';
        console.log(`${engineName.padEnd(8)} | ${short(path).padEnd(44)} | library ${short(name).padEnd(44)} | engine ${JSON.stringify(suggested === null ? null : short(suggested))} (${suggested?.length ?? '-'} chars, ${bytes} bytes) | ${verdict}`);
        await got?.delete().catch(() => {});
    }
    await browser.close();
}
server.close();
