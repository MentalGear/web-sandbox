// Probe 1 of review 3 (I9): does any engine treat a Blob that GuestBytes.image() makes as anything but an image, when its
// URL is opened the ways an embedder (or a careless one) opens it: top-level, in an <iframe>, in an <object>, in an
// <embed>?
//
// image() (src/lib/guest-bytes.ts, imageOf) answers `new Blob([bytes], { type })` for bytes that begin with a signature of
// GUEST_IMAGE_SIGNATURES, typed as that row's type. The signatures below are that table's (a null byte of the table is
// any byte; here 0x00). Behind each signature: an HTML document whose script writes a marker into the host origin's
// localStorage, and, as a second payload, an SVG document with the same script. If any engine sniffs past the type, the
// marker appears and the case reads RAN.
//
// Positive control: the same bytes typed text/html (what a careless `new Blob([bytes()], { type: w.type })` of an .html
// write would do) must read RAN, or the probe sees nothing.
//
// Run: PLAYWRIGHT_BROWSERS_PATH=/home/user/.cache/pw-project node docs/design/review-3/p1-image-polyglot.mjs
import http from 'node:http';
import { chromium, firefox, webkit } from 'playwright';

const ascii = (text) => [...text].map((c) => c.charCodeAt(0));
const SIGNATURES = {
    'image/png': [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    'image/jpeg': [0xff, 0xd8, 0xff],
    'image/gif': ascii('GIF89a'),
    'image/webp': [...ascii('RIFF'), 0, 0, 0, 0, ...ascii('WEBP')],
    'image/avif': [0, 0, 0, 0, ...ascii('ftypavif')],
};
const script = (tag) => `<script>try{localStorage.setItem('ran', ${JSON.stringify(tag)})}catch(e){};document.title='SCRIPT RAN'</script>`;
const PAYLOADS = {
    html: (tag) => `\n<!doctype html><html><body><h1>polyglot</h1>${script(tag)}</body></html>`,
    svg: (tag) => `\n<svg xmlns="http://www.w3.org/2000/svg"><script>try{localStorage.setItem('ran', ${JSON.stringify(tag)})}catch(e){}</script></svg>`,
};

const page = `<!doctype html><title>host</title><body><script>
window.makeUrl = (bytes, type) => URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type }));
window.frameIt = (url, tag) => new Promise((resolve) => {
  const el = document.createElement(tag);
  if (tag === 'iframe' || tag === 'embed') el.src = url; else el.data = url;
  el.onload = () => resolve('load'); el.onerror = () => resolve('error');
  setTimeout(() => resolve('timeout'), 1500);
  document.body.append(el);
});
</script>`;
const server = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(page); });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const ORIGIN = `http://127.0.0.1:${server.address().port}/`;

const cases = [];
for (const [type, signature] of Object.entries(SIGNATURES)) {
    for (const [payload, make] of Object.entries(PAYLOADS)) cases.push({ type, payload, bytes: [...signature, ...ascii(make(`${type}+${payload}`))] });
}
cases.push({ type: 'text/html', payload: 'html (positive control)', bytes: [...SIGNATURES['image/png'], ...ascii(PAYLOADS.html('control'))] });

const WAYS = ['top-level', 'iframe', 'object', 'embed'];
for (const [name, engine] of [['chromium', chromium], ['firefox', firefox], ['webkit', webkit]]) {
    const browser = await engine.launch();
    for (const { type, payload, bytes } of cases) {
        const results = [];
        for (const way of WAYS) {
            const context = await browser.newContext({ acceptDownloads: true });
            const p = await context.newPage();
            await p.goto(ORIGIN);
            let downloaded = false;
            p.on('download', () => { downloaded = true; });
            const url = await p.evaluate(([b, t]) => makeUrl(b, t), [bytes, type]);
            let contentType = '';
            if (way === 'top-level') {
                // the host page's own top-level browsing context navigated to the blob: URL by a link of its own
                // (a link's click from evaluate() was measured not to navigate at all on any engine, so the
                // navigation is Playwright's own goto, which commits the blob: document in the host page's tab)
                await p.goto(url, { timeout: 3000 }).catch((e) => { contentType = `goto: ${e.message.split('\n')[0]}`; });
                await p.waitForTimeout(800);
                contentType += await p.evaluate(() => `${document.contentType} at ${location.protocol}`).catch(() => 'unreadable');
                await p.goto(ORIGIN);
            } else {
                await p.evaluate(([u, tag]) => frameIt(u, tag), [url, way]);
                await p.waitForTimeout(300);
            }
            const ran = await p.evaluate(() => localStorage.getItem('ran')).catch(() => '?');
            results.push(`${way}: ${ran ? 'RAN' : 'inert'}${contentType ? ` (${contentType})` : ''}${downloaded ? ' (download)' : ''}`);
            await context.close();
        }
        console.log(`${name.padEnd(8)} | ${type.padEnd(10)} | ${payload.padEnd(23)} | ${results.join(' | ')}`);
    }
    await browser.close();
}
server.close();
