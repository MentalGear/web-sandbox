// Probe 6 of review 3 (I7's measure, availability): a resizable ArrayBuffer of 8 bytes whose maxByteLength is 1 GiB
// measures 24 bytes (structured-size.ts counts byteLength), and its structured clone keeps maxByteLength (probe 5, Node).
// What does a browser's clone keep, and what do many of them do to the page whose worker makes them, (a) kept in the
// worker, (b) posted to the page as the guest's broker posts a call? Platform only, no library code: the browser
// deserialises a message before any listener (and so the measure) sees it.
//
// The page counts its own timer ticks while it waits, so a page that stops answering shows as no ticks; the Node side
// never waits on the page longer than 25 s.
//
// Run: PLAYWRIGHT_BROWSERS_PATH=/home/user/.cache/pw-project node docs/design/review-3/p6-resizable-buffers.mjs
import http from 'node:http';
import { chromium, firefox, webkit } from 'playwright';

const worker = `
onmessage = (e) => {
  const { count, max, post } = e.data;
  const list = [];
  const started = performance.now();
  try { for (let i = 0; i < count; i++) list.push(new ArrayBuffer(8, { maxByteLength: max })); }
  catch (error) { postMessage({ made: list.length, error: String(error).slice(0, 120) }); return; }
  const makeMs = Math.round(performance.now() - started);
  if (post) postMessage({ made: list.length, makeMs, list });
  else { self.kept = list; postMessage({ made: list.length, makeMs }); }
};`;
const page = `<!doctype html><title>host</title><script>
window.ticks = 0; setInterval(() => window.ticks++, 50);
window.run = (count, max, post) => new Promise((resolve) => {
  const w = new Worker(URL.createObjectURL(new Blob([${JSON.stringify(worker)}], { type: 'text/javascript' })));
  const started = performance.now();
  const ticksBefore = window.ticks;
  const timer = setTimeout(() => resolve({ outcome: 'no message in 15 s', ticks: window.ticks - ticksBefore }), 15000);
  w.onmessageerror = () => { clearTimeout(timer); resolve({ outcome: 'messageerror', ms: Math.round(performance.now() - started) }); };
  w.onerror = (e) => { clearTimeout(timer); resolve({ outcome: 'worker error ' + e.message }); };
  w.onmessage = (e) => {
    clearTimeout(timer);
    const list = e.data.list || [];
    const first = list[0];
    resolve({ outcome: 'message', made: e.data.made, makeMs: e.data.makeMs, error: e.data.error, arrived: list.length, resizable: first ? first.resizable : undefined, maxByteLength: first ? first.maxByteLength : undefined, ms: Math.round(performance.now() - started) });
  };
  w.postMessage({ count, max, post });
});
</script>`;
const server = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(page); });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const ORIGIN = `http://127.0.0.1:${server.address().port}/`;
const GiB = 1024 ** 3;
const within = (promise, ms, label) => Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve(label), ms))]);

for (const [name, engine] of [['chromium', chromium], ['firefox', firefox], ['webkit', webkit]]) {
    for (const post of [false, true]) {
        for (const count of [1, 100, 1000]) {
            const browser = await engine.launch();
            const p = await browser.newPage();
            let crashed = false;
            p.on('crash', () => { crashed = true; });
            await p.goto(ORIGIN);
            const result = await within(p.evaluate(([c, m, s]) => run(c, m, s), [count, GiB, post]).catch((e) => ({ outcome: `evaluate failed: ${e.message.split('\n')[0]}` })), 25000, { outcome: 'THE PAGE DID NOT ANSWER IN 25 s' });
            const alive = await within(p.evaluate(() => window.ticks).then((t) => `answers (${t} ticks)`).catch(() => 'gone'), 5000, 'DOES NOT ANSWER');
            console.log(`${name.padEnd(8)} | ${post ? 'posted' : 'kept  '} | ${String(count).padStart(5)} x 8 bytes, maxByteLength 1 GiB (the measure: ${count * 24} bytes) | ${JSON.stringify(result)} | page after: ${alive}${crashed ? ' (crash event)' : ''}`);
            await within(browser.close(), 10000, null);
        }
    }
}
server.close();
process.exit(0);
