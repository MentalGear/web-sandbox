// Probe 3 of review 2: does the host page's own Service Worker answer the navigation of a frame
// <iframe sandbox="allow-scripts allow-forms" src="/sealed-document.html"> (documentUrl on the host page's origin, in
// the SW's scope)? If it does, a cache-first or app-shell Service Worker (an SPA's navigateFallback) decides what F is.
//
// The SW answers /sealed-document.html with a document of its own whose script reports to the host page.
import http from 'node:http';
import { chromium, firefox, webkit } from 'playwright';

const sw = `self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.pathname !== '/sealed-document.html') return;
  e.respondWith(new Response('<!doctype html><script>parent.postMessage({ from: "the service worker\\'s answer", mode: "' + e.request.mode + '", dest: "' + e.request.destination + '", origin: self.origin }, "*")</script>',
    { headers: { 'content-type': 'text/html' } }));
});`;

const file = `<!doctype html><script>parent.postMessage({ from: 'the server (the real file)', origin: self.origin }, '*')</script>`;

const host = `<!doctype html><script>
window.__out = [];
onmessage = (e) => window.__out.push(e.data);
window.run = async (sandbox) => {
  await navigator.serviceWorker.register('/sw.js');
  await navigator.serviceWorker.ready;
  if (!navigator.serviceWorker.controller) await new Promise((r) => navigator.serviceWorker.addEventListener('controllerchange', r, { once: true }));
  const f = document.createElement('iframe');
  if (sandbox !== null) f.setAttribute('sandbox', sandbox);
  f.src = '/sealed-document.html';
  document.body.append(f);
  await new Promise((r) => setTimeout(r, 1500));
  return window.__out;
};
</script>`;

const server = http.createServer((req, res) => {
  const p = new URL(req.url, 'http://x').pathname;
  if (p === '/sw.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); return res.end(sw); }
  if (p === '/sealed-document.html') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(file); }
  res.writeHead(200, { 'content-type': 'text/html' }); res.end(host);
});
await new Promise((r) => server.listen(24831, '127.0.0.1', r));

for (const [name, type] of [['chromium', chromium], ['firefox', firefox], ['webkit', webkit]]) {
  for (const sandbox of ['allow-scripts allow-forms', 'allow-scripts allow-same-origin', null]) {
    const browser = await type.launch();
    const page = await browser.newPage();
    await page.goto('http://localhost:24831/');
    const out = await page.evaluate((s) => window.run(s), sandbox).catch((e) => [{ error: e.message }]);
    console.log(`${name.padEnd(8)} | sandbox=${JSON.stringify(sandbox).padEnd(36)} | ${JSON.stringify(out)}`);
    await browser.close();
  }
}
server.close();
