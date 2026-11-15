// Q4b. Process placement: does a busy loop in the served file F, its view C or its worker W stall a host-page timer, when
// F is served from the host page's own origin, from another site, or from another registrable domain, against today's
// srcdoc topology? On Chromium, which renderer process runs each frame?
//
//   bun docs/research/28_served_topology/q4-thread.mjs <engine> [reps]     # default 5 reps
//   engines: chromium (the headless shell), chromium-full (the full build, new headless), firefox, webkit
//
// Configurations per engine: chromium and chromium-full each with the default flags and with --site-per-process;
// firefox with Playwright's defaults and with the pref fission.autostart = true; webkit with its defaults.
//
// One host page holds, at once:
//   today        iframe[sandbox] srcdoc (the wrapper, no script) > iframe[sandbox] srcdoc (the view) > blob: worker
//   same-origin  iframe[sandbox] src=http://localhost:P/F.html > C (srcdoc, sandbox) > blob: worker made by C
//   cross-site   the same from http://127.0.0.1:P (another site: an IP address is its own site)
//   other-domain the same from http://files.other.test:P, the host page being http://app.example.test:P, both reached
//                through the server, which is its own forward proxy (the browser is launched with it as proxy); this
//                pair is the "second hostname" case with two registrable domains
//   control      a cross-site frame without the sandbox attribute (the frame site isolation exists for)
// The host page itself is http://app.example.test:P, so `same-origin` there is the file on app.example.test.
//
// Timing: the host runs a 10 ms interval for 2000 ms; at 300 ms the named target busy-loops for 1200 ms; the result is
// the host's longest gap between ticks (1200 = the loop stalled the host for its whole length), median and range of the
// reps, with the 1-minute load average. Process mapping (Chromium): CDP SystemInfo.getProcessInfo, the renderer whose CPU
// time rises while the frame loops for 900 ms (research 20 Q4's method), and Target.getTargets' out-of-process frames.
// A research script: it reports figures and asserts nothing.
import { chromium, firefox, webkit } from 'playwright';
import { emit, esc, load1, median, range, sleep } from './lib.mjs';
import { HTML, startServer } from './server.mjs';

const LISTENER = `const busy = (ms) => { const end = performance.now() + ms; while (performance.now() < end); };`;
const W_SRC = `${LISTENER} onmessage = (e) => busy(e.data.ms);`;
// the view (today's and C alike): loops on 'C' (or 'view'), forwards 'W' to its worker
const VIEW = `${LISTENER}
const w = new Worker(URL.createObjectURL(new Blob([${JSON.stringify(W_SRC)}], { type: 'text/javascript' })));
addEventListener('message', (e) => { const d = e.data || {}; if (d.target === 'W') w.postMessage(d); else if (d.target) busy(d.ms); });`;
const VIEW_HTML = `<!doctype html><html><head><meta charset="utf-8"></head><body><script>${VIEW}<\/script></body></html>`;
const WRAPPER_HTML = `<!doctype html><html><head><meta charset="utf-8"></head><body><iframe sandbox="allow-scripts" srcdoc="${esc(VIEW_HTML)}"></iframe></body></html>`;
const F_HTML = `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; worker-src blob:"><meta charset="utf-8"></head><body><iframe sandbox="allow-scripts" srcdoc="${esc(VIEW_HTML)}"></iframe><script>
${LISTENER}
addEventListener('message', (e) => { const d = e.data || {}; if (d.target === 'F') busy(d.ms); else if (d.target) frames[0].postMessage(d, '*'); });
<\/script></body></html>`;
const PLAIN = `<!doctype html><html><head><meta charset="utf-8"></head><body><script>${LISTENER} addEventListener('message', (e) => { if (e.data && e.data.target) busy(e.data.ms); });<\/script></body></html>`;
const HOST = `<!doctype html><html><head><meta charset="utf-8"></head><body><script>
window.frames_ = {};
window.mk = (id, attrs) => { const f = document.createElement('iframe'); for (const [k, v] of Object.entries(attrs)) f.setAttribute(k, v); document.body.appendChild(f); frames_[id] = f; return new Promise((r) => f.addEventListener('load', () => setTimeout(r, 500))); };
window.post = (id, msg) => (id === 'today' ? frames_[id].contentWindow.frames[0] : frames_[id].contentWindow).postMessage(msg, '*');
window.hostBusy = (ms) => { const end = performance.now() + ms; while (performance.now() < end); };
window.measure = (windowMs, id, msg) => new Promise((res) => {
  let last = performance.now(), max = 0, ticks = 0;
  const t = setInterval(() => { const n = performance.now(); max = Math.max(max, n - last); last = n; ticks++; }, 10);
  if (id) setTimeout(() => window.post(id, msg), 300);
  setTimeout(() => { clearInterval(t); res({ maxGap: Math.round(max), ticks }); }, windowMs);
});
<\/script></body></html>`;

const CONFIGS = {
    chromium: [['shell, default', chromium, {}], ['shell, --site-per-process', chromium, { args: ['--site-per-process'] }]],
    'chromium-full': [['full, default', chromium, { channel: 'chromium' }], ['full, --site-per-process', chromium, { channel: 'chromium', args: ['--site-per-process'] }]],
    firefox: [['default (Playwright)', firefox, {}], ['fission.autostart = true', firefox, { firefoxUserPrefs: { 'fission.autostart': true } }]],
    webkit: [['default', webkit, {}]],
};

const procs = async (bs) => (await bs.send('SystemInfo.getProcessInfo')).processInfo.filter((p) => p.type === 'renderer');
async function whichProcess(bs, fn) {
    const a = await procs(bs);
    await fn();
    const b = await procs(bs);
    const grew = b.map((p) => ({ id: p.id, d: p.cpuTime - (a.find((q) => q.id === p.id)?.cpuTime ?? 0) })).sort((x, y) => y.d - x.d);
    return grew[0] && grew[0].d > 0.3 ? grew[0].id : null;
}

async function runConfig(engine, label, type, options, reps, srv) {
    const P = srv.port;
    const HOSTURL = `http://app.example.test:${P}`;
    const browser = await type.launch({ ...options, proxy: { server: srv.ip } });
    emit('q4b.run', { engine, config: label, version: browser.version(), date: new Date().toISOString(), load1: load1() });
    const page = await (await browser.newContext()).newPage();
    await page.goto(`${HOSTURL}/host.html`);
    await page.evaluate(([w, P2]) => Promise.all([
        window.mk('today', { sandbox: 'allow-scripts', referrerpolicy: 'no-referrer', srcdoc: w }),
        window.mk('same-origin', { sandbox: 'allow-scripts', referrerpolicy: 'no-referrer', src: '/F.html' }),
        window.mk('cross-site', { sandbox: 'allow-scripts', referrerpolicy: 'no-referrer', src: `http://127.0.0.1:${P2}/F.html` }),
        window.mk('other-domain', { sandbox: 'allow-scripts', referrerpolicy: 'no-referrer', src: `http://files.other.test:${P2}/F.html` }),
        window.mk('control', { src: `http://files.other.test:${P2}/plain.html` }),
    ]), [WRAPPER_HTML, P]);
    const CASES = [
        ['idle', null, null],
        ["today's view", 'today', { target: 'C', ms: 1200 }],
        ["today's worker", 'today', { target: 'W', ms: 1200 }],
        ['same-origin F', 'same-origin', { target: 'F', ms: 1200 }],
        ['same-origin C', 'same-origin', { target: 'C', ms: 1200 }],
        ['same-origin W', 'same-origin', { target: 'W', ms: 1200 }],
        ['cross-site F', 'cross-site', { target: 'F', ms: 1200 }],
        ['cross-site C', 'cross-site', { target: 'C', ms: 1200 }],
        ['cross-site W', 'cross-site', { target: 'W', ms: 1200 }],
        ['other-domain F', 'other-domain', { target: 'F', ms: 1200 }],
        ['other-domain C', 'other-domain', { target: 'C', ms: 1200 }],
        ['other-domain W', 'other-domain', { target: 'W', ms: 1200 }],
        ['control: cross-site frame, no sandbox', 'control', { target: 'F', ms: 1200 }],
    ];
    if (engine.startsWith('chromium')) {
        const bs = await browser.newBrowserCDPSession();
        const targets = (await bs.send('Target.getTargets')).targetInfos.filter((t) => t.type === 'iframe' || t.type === 'page').map((t) => `${t.type}:${t.url.slice(0, 50)}`);
        const rendererOf = { host: await whichProcess(bs, () => page.evaluate(() => window.hostBusy(900))) };
        for (const [name, id, msg] of CASES.slice(1)) {
            if (msg.target === 'W') continue; // a worker runs in its document's renderer
            rendererOf[name] = await whichProcess(bs, async () => { await page.evaluate(([i, m]) => window.post(i, m), [id, { ...msg, ms: 900 }]); await sleep(1100); });
        }
        emit('q4b.processes', { engine, config: label, renderers: (await procs(bs)).length, oopifTargets: targets, rendererOf });
    }
    for (const [name, id, msg] of CASES) {
        const gaps = [];
        const loads = [];
        for (let i = 0; i < reps; i++) {
            loads.push(load1());
            gaps.push((await page.evaluate(([a, b]) => window.measure(2000, a, b), [id, msg])).maxGap);
            await sleep(300);
        }
        emit('q4b', { engine, config: label, case: name, median: median(gaps), range: range(gaps), gaps, load1: loads });
    }
    await browser.close();
}

const args = process.argv.slice(2);
const reps = Number(args.find((a) => /^\d+$/.test(a)) ?? 5);
const srv = await startServer();
srv.route('/host.html', { headers: HTML, body: HOST });
srv.route('/F.html', { headers: HTML, body: F_HTML });
srv.route('/plain.html', { headers: HTML, body: PLAIN });
for (const engine of args.filter((a) => a in CONFIGS)) {
    for (const [label, type, options] of CONFIGS[engine]) {
        try { await runConfig(engine, label, type, options, reps, srv); } catch (e) { emit('q4b.error', { engine, config: label, error: String(e).slice(0, 400) }); }
    }
}
await srv.close();
process.exit(0); // the servers' keep-alive sockets must not hold the run open after an error
