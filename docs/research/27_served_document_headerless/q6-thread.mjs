// Q6. Thread placement on Firefox and WebKit (research 20 Q4 did Chromium): does a busy loop in the served frame delay a
// host-page timer, versus today's srcdoc frame?
//
//   bun docs/research/27_served_document_headerless/q6-thread.mjs [firefox|webkit|chromium] [reps]   # default: firefox webkit, 5 reps
//
// One host page holds, at once: today's srcdoc frame; the served frame (header-less, sandbox="allow-scripts") with its
// srcdoc child and its blob: worker; a non-sandboxed cross-site frame (http://127.0.0.1:P, the control: site isolation
// would put it in another process); and a non-sandboxed same-origin frame. The host runs a 10 ms interval for 2000 ms; at
// 300 ms the named target busy-loops for 1200 ms. The result is the host's longest gap between ticks (1200 = the loop
// stalled the host for its whole length). Each case is repeated; the median and range are given, with the 1-minute load
// average at the start of each case.
import { ENGINES, emit, emitRun, esc, load1, median, range, sleep } from './lib.mjs';
import { HTML, startServer } from './server.mjs';

const LISTENER = `addEventListener('message', (e) => { if (e.data && e.data.busy) { const end = performance.now() + e.data.busy; while (performance.now() < end); } });`;
const CHILD = `<script>${LISTENER}<\/script>`;
const WORKER = `onmessage = (e) => { const end = performance.now() + e.data.busy; while (performance.now() < end); };`;
const FRAME = `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; worker-src blob:"><meta charset="utf-8"></head><body><iframe id="c" sandbox="allow-scripts" srcdoc="${esc(CHILD)}"></iframe><script>
${LISTENER}
const w = new Worker(URL.createObjectURL(new Blob([${JSON.stringify(WORKER)}], { type: 'text/javascript' })));
addEventListener('message', (e) => { if (e.data && e.data.child) document.getElementById('c').contentWindow.postMessage({ busy: e.data.child }, '*'); if (e.data && e.data.worker) w.postMessage({ busy: e.data.worker }); });
<\/script></body></html>`;
const PLAIN = `<!doctype html><html><head><meta charset="utf-8"></head><body><script>${LISTENER}<\/script></body></html>`;
const HOST = `<!doctype html><html><head><meta charset="utf-8"></head><body><script>
window.frames_ = {};
window.mk = (id, attrs) => { const f = document.createElement('iframe'); for (const [k, v] of Object.entries(attrs)) f.setAttribute(k, v); document.body.appendChild(f); frames_[id] = f; return new Promise((r) => f.addEventListener('load', () => setTimeout(r, 400))); };
window.measure = (windowMs, id, msg) => new Promise((res) => {
  let last = performance.now(), max = 0, ticks = 0;
  const t = setInterval(() => { const n = performance.now(); max = Math.max(max, n - last); last = n; ticks++; }, 10);
  if (id) setTimeout(() => frames_[id].contentWindow.postMessage(msg, '*'), 300);
  setTimeout(() => { clearInterval(t); res({ maxGap: Math.round(max), ticks }); }, windowMs);
});
<\/script></body></html>`;

const argv = process.argv.slice(2);
const engines = argv.filter((a) => a in ENGINES);
const reps = Number(argv.find((a) => /^\d+$/.test(a)) ?? 5);

async function runEngine(name) {
    const srv = await startServer();
    srv.route('/host.html', { headers: HTML, body: HOST });
    srv.route('/frame.html', { headers: HTML, body: FRAME });
    srv.route('/plain.html', { headers: HTML, body: PLAIN });
    const browser = await ENGINES[name].launch();
    emitRun('q6', name, browser);
    const page = await (await browser.newContext()).newPage();
    await page.goto(`${srv.local}/host.html`);
    const srcdoc = `<!doctype html><html><body><script>${LISTENER}<\/script></body></html>`;
    await page.evaluate((s) => Promise.all([
        window.mk('srcdoc', { sandbox: 'allow-scripts', srcdoc: s }),
        window.mk('served', { sandbox: 'allow-scripts', src: '/frame.html' }),
        window.mk('cross-site', { src: `${location.protocol}//127.0.0.1:${location.port}/plain.html` }),
        window.mk('same-origin', { src: '/plain.html' }),
    ]), srcdoc);
    const CASES = [
        ['idle', null, null],
        ["today's srcdoc frame", 'srcdoc', { busy: 1200 }],
        ['served frame', 'served', { busy: 1200 }],
        ["served frame's srcdoc child", 'served', { child: 1200 }],
        ["served frame's blob: worker", 'served', { worker: 1200 }],
        ['cross-site frame, no sandbox (control)', 'cross-site', { busy: 1200 }],
        ['same-origin frame, no sandbox (control)', 'same-origin', { busy: 1200 }],
    ];
    for (const [label, id, msg] of CASES) {
        const gaps = [];
        const loads = [];
        for (let i = 0; i < reps; i++) {
            loads.push(load1());
            gaps.push((await page.evaluate(([a, b]) => window.measure(2000, a, b), [id, msg])).maxGap);
            await sleep(300);
        }
        emit('q6', { engine: name, case: label, median: median(gaps), range: range(gaps), gaps, load1: loads });
    }
    await browser.close();
    await srv.close();
}

for (const name of engines.length ? engines : ['firefox', 'webkit']) {
    try { await runEngine(name); } catch (e) { emit('q6.error', { engine: name, error: String(e).slice(0, 400) }); }
}
