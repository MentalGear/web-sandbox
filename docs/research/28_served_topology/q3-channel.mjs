// Q3. The channel: can the host page hold a MessagePort whose other end is in the worker (and one in the view C), with
// the served file F handing the ports on once at start-up and relaying nothing after? What does the extra document cost
// at start-up, and the extra hop in round-trip time, against today's topology?
//
//   bun docs/research/28_served_topology/q3-channel.mjs <engine> [runs]     # default 12 runs per topology
//
// Today's topology, as the library builds it: host -> iframe[sandbox] srcdoc (the wrapper, no script) -> iframe[sandbox]
// srcdoc (the view) -> blob: worker; the host posts the view the ports and the worker source, the view starts the worker
// and hands it one port. The trampoline: host -> iframe[sandbox] src=F (Content-Type only, a <meta> policy, its script by
// hash) -> F creates C (srcdoc, sandbox) and on C's load posts it the ports, then removes its listener -> C starts the
// worker and hands it one port. After the hand-over F tries to post on the port it transferred (it must not arrive), and
// C keeps the second port (the view's channel: one round trip on it too).
//
// Per run: a fresh frame; start-up = from the iframe's insertion to the worker's 'ready' on the host's port; then 200
// sequential round trips of a small message, and 50 of a 64 KiB string, on the worker's port, and 200 on the view's
// port; each the mean over its span (one round trip is below the clock's resolution). The topologies alternate run by run. This is a research script: it reports figures
// with the load average and asserts nothing.
import { ENGINES, emit, emitRun, esc, load1, median, range, sha, sleep } from './lib.mjs';
import { HTML, startServer } from './server.mjs';

const WORKER = `onmessage = (e) => { const p = e.ports[0]; p.onmessage = (m) => p.postMessage(m.data); p.postMessage('ready'); };`;
// the view: takes the ports and the worker source from its parent's first message, keeps one port, starts the worker with the other
const VIEW = `addEventListener('message', (e) => {
  // today the host posts (the wrapper's parent), in the trampoline F does (the parent)
  if ((e.source !== parent && e.source !== parent.parent) || !e.data || !e.data.src) return;
  const [toWorker, toView] = e.ports;
  toView.onmessage = (m) => toView.postMessage(m.data);
  const w = new Worker(URL.createObjectURL(new Blob([e.data.src], { type: 'text/javascript' })));
  w.postMessage(null, [toWorker]);
}, { once: true });`;
const VIEW_HTML = `<!doctype html><html><head><meta charset="utf-8"></head><body><script>${VIEW}</script></body></html>`;
const WRAPPER_HTML = `<!doctype html><html><head><meta charset="utf-8"></head><body><iframe sandbox="allow-scripts" srcdoc="${esc(VIEW_HTML)}"></iframe></body></html>`;
// F: hands the ports on to C once, then has no listener and no port
const F_SCRIPT = `(() => {
  const onInit = (e) => {
    if (!e.data || !e.data.src) return;
    removeEventListener('message', onInit);
    const ports = e.ports;
    const c = document.createElement('iframe');
    c.setAttribute('sandbox', 'allow-scripts');
    c.srcdoc = ${JSON.stringify(VIEW_HTML).replaceAll('</', '<\\/')};
    c.addEventListener('load', () => {
      c.contentWindow.postMessage({ src: e.data.src }, '*', [...ports]);
      try { ports[0].postMessage('from F after the transfer'); } catch {}
    }, { once: true });
    document.body.append(c);
  };
  addEventListener('message', onInit);
})();`;
const F_POLICY = `default-src 'none'; script-src ${sha(F_SCRIPT)} ${sha(VIEW)}; connect-src 'none'; worker-src blob:; base-uri 'none'`;
const F_HTML = `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${esc(F_POLICY)}"><meta charset="utf-8"></head><body><script>${F_SCRIPT}</script></body></html>`;

const HOST = `<!doctype html><html><head><meta charset="utf-8"></head><body><script>
window.run = async (topology, wrapper, src, n, big, viewN) => {
  const f = document.createElement('iframe');
  f.setAttribute('sandbox', 'allow-scripts');
  f.setAttribute('referrerpolicy', 'no-referrer');
  const worker = new MessageChannel(), view = new MessageChannel();
  const stray = [];
  const t0 = performance.now();
  const ready = new Promise((res) => { worker.port1.onmessage = (m) => { if (m.data === 'ready') res(performance.now() - t0); else stray.push(m.data); }; });
  const loaded = new Promise((res) => f.addEventListener('load', res, { once: true }));
  if (topology === 'today') f.srcdoc = wrapper; else f.src = '/F.html';
  document.body.append(f);
  await loaded;
  const target = topology === 'today' ? f.contentWindow.frames[0] : f.contentWindow;
  // the wrapper's load waits for the view's (a subframe), as the library's INIT_VIEW does; F's for its own document only
  target.postMessage({ src }, '*', [worker.port2, view.port2]);
  const startup = await Promise.race([ready, new Promise((r) => setTimeout(() => r(undefined), 5000))]);
  if (startup === undefined) { f.remove(); return { error: 'no ready' }; }
  // the mean of count sequential round trips, timed as one span (one round trip is below the clock resolution)
  const rtt = async (port, payload, count) => {
    const began = performance.now();
    for (let i = 0; i < count; i++) await new Promise((res) => { port.onmessage = () => res(); port.postMessage(payload); });
    return (performance.now() - began) / count;
  };
  const small = await rtt(worker.port1, { seq: 1, text: 'ping' }, n);
  const large = await rtt(worker.port1, big, 50);
  const viewRtt = await rtt(view.port1, { seq: 1, text: 'ping' }, viewN);
  await new Promise((r) => setTimeout(r, 50));
  f.remove();
  worker.port1.close(); view.port1.close();
  return { startup, small, large, view: viewRtt, stray };
};
<\/script></body></html>`;

async function runEngine(name, runs) {
    const srv = await startServer();
    srv.route('/host.html', { headers: HTML, body: HOST });
    srv.route('/F.html', { headers: HTML, body: F_HTML });
    const browser = await ENGINES[name].launch();
    emitRun('q3', name, browser);
    const page = await (await browser.newContext()).newPage();
    await page.goto(`${srv.local}/host.html`);
    const big = 'x'.repeat(65536);
    const rows = { today: [], trampoline: [] };
    const loads = [];
    // one warm-up of each, not counted
    for (const t of ['today', 'trampoline']) await page.evaluate(([a, b, c, d]) => window.run(a, b, c, 20, d, 20), [t, WRAPPER_HTML, WORKER, big]);
    for (let i = 0; i < runs; i++) {
        for (const t of i % 2 ? ['trampoline', 'today'] : ['today', 'trampoline']) {
            loads.push(load1());
            const r = await page.evaluate(([a, b, c, d]) => window.run(a, b, c, 200, d, 200), [t, WRAPPER_HTML, WORKER, big]);
            rows[t].push(r);
            emit('q3.run', { engine: name, topology: t, run: i, ...r, load1: loads[loads.length - 1] });
            await sleep(100);
        }
    }
    for (const [t, rs] of Object.entries(rows)) {
        const ok = rs.filter((r) => !r.error);
        const stat = (k) => ({ median: +median(ok.map((r) => r[k])).toFixed(3), range: range(ok.map((r) => +r[k].toFixed(3))) });
        emit('q3', { engine: name, topology: t, runs: ok.length, failed: rs.length - ok.length, startupMs: stat('startup'), rttSmallMs: stat('small'), rtt64KiBMs: stat('large'), rttViewPortMs: stat('view'), strayFromF: ok.flatMap((r) => r.stray), load1: range(loads) });
    }
    await browser.close();
    await srv.close();
}

const args = process.argv.slice(2);
const runs = Number(args.find((a) => /^\d+$/.test(a)) ?? 12);
for (const name of args.filter((a) => a in ENGINES)) {
    try { await runEngine(name, runs); } catch (e) { emit('q3.error', { engine: name, error: String(e).slice(0, 400) }); }
}
process.exit(0); // the servers' keep-alive sockets must not hold the run open after an error
