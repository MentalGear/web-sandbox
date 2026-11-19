// P2: does a non-bubbling event dispatched on an element reach a capturing listener on document and window?
// P3: in the design's shape (F framed sandbox="allow-scripts", C in F's markup with sandbox="allow-scripts allow-forms"),
//     does a form submission in C dispatch `submit`? Control: F framed "allow-scripts allow-forms".
import http from 'node:http';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire('/home/user/web-sandbox/package.json');
const pw = require('playwright');

const esc = (s) => s.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const C_SCRIPT = `const f = document.forms[0]; let n = 0; f.addEventListener('submit', (e) => { n++; e.preventDefault(); });
document.querySelector('button').click(); try { f.requestSubmit(); } catch (e) {}
setTimeout(() => parent.parent.postMessage({ submits: n }, '*'), 300);`;
const C_DOC = `<!doctype html><meta charset="utf-8"><body><form><input name="a" value="x"><button type="submit">go</button></form><script>${C_SCRIPT}</script></body>`;
const F = `<!doctype html><meta charset="utf-8"><body><iframe sandbox="allow-scripts allow-forms" srcdoc="${esc(C_DOC)}"></iframe></body>`;
const HOST = (flags) => `<!doctype html><meta charset="utf-8"><body><div id="anc"><x-el id="el"></x-el></div><script>
const seen = [];
window.addEventListener('sandbox-log', () => seen.push('window-capture'), true);
document.addEventListener('sandbox-log', () => seen.push('document-capture'), true);
document.getElementById('anc').addEventListener('sandbox-log', () => seen.push('ancestor-capture'), true);
document.addEventListener('sandbox-log', () => seen.push('document-bubble'));
document.getElementById('el').dispatchEvent(new CustomEvent('sandbox-log', { bubbles: false, detail: 'guest text' }));
window.P2 = seen;
addEventListener('message', (e) => { if (e.data && 'submits' in e.data) window.P3 = e.data.submits; });
const f = document.createElement('iframe'); f.setAttribute('sandbox', '${flags}'); f.src = '/f.html'; document.body.append(f);
</script></body>`;

const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    if (req.url === '/f.html') return res.end(F);
    if (req.url === '/host-a.html') return res.end(HOST('allow-scripts'));
    if (req.url === '/host-b.html') return res.end(HOST('allow-scripts allow-forms'));
    res.end('');
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
for (const engine of ['chromium', 'firefox', 'webkit']) {
    const browser = await pw[engine].launch();
    for (const host of ['host-a', 'host-b']) {
        const page = await browser.newPage();
        await page.goto(`http://localhost:${port}/${host}.html`);
        await page.waitForFunction(() => window.P3 !== undefined, null, { timeout: 5000 }).catch(() => {});
        const r = await page.evaluate(() => ({ p2: window.P2, p3: window.P3 }));
        console.log(`${engine} | F sandbox=${host === 'host-a' ? '"allow-scripts"' : '"allow-scripts allow-forms"'} | submit events in C: ${r.p3} | non-bubbling event seen by: ${r.p2.join(', ')}`);
        await page.close();
    }
    await browser.close();
}
server.close();
