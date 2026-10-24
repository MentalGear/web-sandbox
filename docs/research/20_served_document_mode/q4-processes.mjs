// Q4. Chromium only. Is the served sandboxed frame in a different renderer process from the host page, versus today's
// srcdoc frame? Does a busy loop in the served frame's srcdoc child delay a host-page timer, versus today's srcdoc frame?
//
//   bun docs/research/20_served_document_mode/q4-processes.mjs [shell|desktop] [reps]   # default: both builds, 5 reps
//
// Builds: 'shell' is Playwright's headless shell (the default `chromium` project), 'desktop' is the full Chromium in
// new headless mode (`channel: 'chromium'`). Flag sets, appended to Playwright's own arguments:
//   default            nothing (site isolation as Playwright leaves it)
//   no-sandbox-iso     --disable-features=IsolateSandboxedIframes (plus Playwright's own disabled list, which a second
//                      --disable-features would otherwise replace)
//   no-site-iso        --disable-site-isolation-trials --disable-features=site-per-process,IsolateOrigins,IsolateSandboxedIframes
//   site-per-process   --site-per-process (explicit)
//
// Process mapping: CDP Target.getTargets / Target.setAutoAttach(flatten) list the out-of-process frames (targets of type
// 'iframe'); SystemInfo.getProcessInfo gives each renderer's CPU time, and the frame whose busy loop raises one
// renderer's CPU time is in that process. Timing: the host page runs a 10 ms interval; a frame busy-loops for 1200 ms
// inside a 2000 ms window; the table is the host's longest gap between ticks, per run. Run it alone.
import { ENGINES, emit, load1, median, range, sleep, waitForQuiet } from './lib.mjs';
import { startServer } from './server.mjs';

const PW_DISABLED = ['AvoidUnnecessaryBeforeUnloadCheckSync', 'BoundaryEventDispatchTracksNodeRemoval', 'DestroyProfileOnBrowserClose', 'DialMediaRouteProvider', 'GlobalMediaControls', 'HttpsUpgrades', 'LensOverlay', 'MediaRouter', 'PaintHolding', 'ThirdPartyStoragePartitioning', 'Translate', 'AutoDeElevate', 'RenderDocument', 'OptimizationHints'];
const FLAGS = {
    'default': [],
    'no-sandbox-iso': [`--disable-features=${[...PW_DISABLED, 'IsolateSandboxedIframes'].join(',')}`],
    'no-site-iso': ['--disable-site-isolation-trials', `--disable-features=${[...PW_DISABLED, 'site-per-process', 'IsolateOrigins', 'IsolateSandboxedIframes'].join(',')}`],
    'site-per-process': ['--site-per-process'],
};
const BUILDS = { shell: {}, desktop: { channel: 'chromium' } };

const LISTENER = `addEventListener('message', (e) => { if (e.data && e.data.busy) { const end = performance.now() + e.data.busy; while (performance.now() < end); } });`;
const esc = (s) => s.replaceAll('&', '&amp;').replaceAll('"', '&quot;');
const CHILD = `<script>${LISTENER}<\/script>`;
// the served frame: busy on request, or relays the request to its srcdoc child
const FRAME = `<!doctype html><html><head><meta charset="utf-8"></head><body><iframe id="c" sandbox="allow-scripts" srcdoc="${esc(CHILD)}"></iframe><script>
${LISTENER}
addEventListener('message', (e) => { if (e.data && e.data.child) document.getElementById('c').contentWindow.postMessage({ busy: e.data.child }, '*'); });
<\/script></body></html>`;

const HOST = `<!doctype html><html><head><meta charset="utf-8"></head><body><script>
window.frames_ = {};
window.mk = (id, attrs) => { const f = document.createElement('iframe'); for (const [k, v] of Object.entries(attrs)) f.setAttribute(k, v); document.body.appendChild(f); frames_[id] = f; return new Promise((r) => f.addEventListener('load', () => setTimeout(r, 400))); };
window.clearFrames = () => { for (const f of Object.values(frames_)) f.remove(); for (const k of Object.keys(frames_)) delete frames_[k]; };
window.hostBusy = (ms) => { const end = performance.now() + ms; while (performance.now() < end); };
// ticks every 10 ms for windowMs; at 300 ms the target is told to busy-loop for busyMs
window.measure = (windowMs, id, msg) => new Promise((res) => {
  let last = performance.now(), max = 0, ticks = 0;
  const t = setInterval(() => { const n = performance.now(); max = Math.max(max, n - last); last = n; ticks++; }, 10);
  if (id) setTimeout(() => frames_[id].contentWindow.postMessage(msg, '*'), 300);
  setTimeout(() => { clearInterval(t); res({ maxGap: Math.round(max), ticks }); }, windowMs);
});
<\/script></body></html>`;

const procs = async (bs) => (await bs.send('SystemInfo.getProcessInfo')).processInfo.filter((p) => p.type === 'renderer');
/** The renderer whose CPU time grew most while fn ran. */
async function whichProcess(bs, fn) {
    const a = await procs(bs);
    await fn();
    const b = await procs(bs);
    const grew = b.map((p) => ({ id: p.id, d: p.cpuTime - (a.find((q) => q.id === p.id)?.cpuTime ?? 0) })).sort((x, y) => y.d - x.d);
    return grew[0] && grew[0].d > 0.3 ? grew[0].id : null;
}

async function runConfig(build, flagName, reps, srv) {
    await waitForQuiet(6, `${build}/${flagName}`);
    const browser = await ENGINES.chromium.launch({ ...BUILDS[build], args: FLAGS[flagName] });
    const bs = await browser.newBrowserCDPSession();
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(`${srv.local}/host.html`);

    // 1. the frames present together
    await page.evaluate(async () => {
        await Promise.all([
            window.mk('srcdoc', { sandbox: 'allow-scripts', srcdoc: '<script>' + "addEventListener('message', (e) => { if (e.data && e.data.busy) { const end = performance.now() + e.data.busy; while (performance.now() < end); } });" + '<\/script>' }),
            window.mk('served', { sandbox: 'allow-scripts', src: '/frame.html' }),
            window.mk('plain', { src: '/frame-plain.html' }),
            window.mk('srcdoc-2', { sandbox: 'allow-scripts', srcdoc: '<script>' + "addEventListener('message', (e) => { if (e.data && e.data.busy) { const end = performance.now() + e.data.busy; while (performance.now() < end); } });" + '<\/script>' }),
            window.mk('served-2', { sandbox: 'allow-scripts', src: '/frame.html?second' }),
            // with the attributes the library puts on its wrapper iframe (credentialless is Chromium-only)
            window.mk('srcdoc-lib', { sandbox: 'allow-scripts', credentialless: '', referrerpolicy: 'no-referrer', srcdoc: '<script>' + "addEventListener('message', (e) => { if (e.data && e.data.busy) { const end = performance.now() + e.data.busy; while (performance.now() < end); } });" + '<\/script>' }),
            window.mk('served-lib', { sandbox: 'allow-scripts', credentialless: '', referrerpolicy: 'no-referrer', src: '/frame.html?lib' }),
        ]);
    });
    const targets = (await bs.send('Target.getTargets')).targetInfos.filter((t) => t.type === 'iframe' || t.type === 'page').map((t) => `${t.type}:${t.url.slice(0, 60)}`);
    const all = await procs(bs);
    // 2. which renderer runs which frame, by CPU time
    const hostProc = await whichProcess(bs, () => page.evaluate(() => window.hostBusy(900)));
    const proc = { host: hostProc };
    for (const [label, id, msg] of [['srcdoc (today)', 'srcdoc', { busy: 900 }], ['served', 'served', { busy: 900 }], ['served>srcdoc child', 'served', { child: 900 }], ['plain same-origin frame', 'plain', { busy: 900 }], ['second srcdoc frame', 'srcdoc-2', { busy: 900 }], ['second served frame', 'served-2', { busy: 900 }], ['srcdoc + credentialless (the library today)', 'srcdoc-lib', { busy: 900 }], ['served + credentialless', 'served-lib', { busy: 900 }], ['served + credentialless > srcdoc child', 'served-lib', { child: 900 }]]) {
        proc[label] = await whichProcess(bs, async () => { await page.evaluate(([i, m]) => window.frames_[i].contentWindow.postMessage(m, '*'), [id, msg]); await sleep(1100); });
    }
    emit('q4.processes', { build, flags: flagName, renderersWithAllFrames: all.length, oopifTargets: targets, rendererOf: proc });

    // 3. timers: host max gap while a frame loops
    const cases = [
        ['idle (no loop)', null, null],
        ['srcdoc frame loops (today)', 'srcdoc', { busy: 1200 }],
        ['served frame loops', 'served', { busy: 1200 }],
        ['served frame\'s srcdoc child loops', 'served', { child: 1200 }],
        ['plain same-origin frame loops (control)', 'plain', { busy: 1200 }],
        ['srcdoc + credentialless loops (the library today)', 'srcdoc-lib', { busy: 1200 }],
        ['served + credentialless frame\'s srcdoc child loops', 'served-lib', { child: 1200 }],
    ];
    const rows = {};
    for (const [label] of cases) rows[label] = { gaps: [], ticks: [] };
    for (let i = 0; i < reps; i++) {
        for (const [label, id, msg] of cases) {
            await waitForQuiet(6, 'timing');
            const r = await page.evaluate(([i2, m]) => window.measure(2000, i2, m), [id, msg]);
            await sleep(300);
            rows[label].gaps.push(r.maxGap); rows[label].ticks.push(r.ticks);
        }
    }
    for (const [label] of cases) emit('q4.timer', { build, flags: flagName, case: label, reps, maxGapMsMedian: median(rows[label].gaps), maxGapMsRange: range(rows[label].gaps), ticksMedian: median(rows[label].ticks), ticksRange: range(rows[label].ticks), load1After: load1() });
    await browser.close();
}

const args = process.argv.slice(2);
const builds = args.filter((a) => a in BUILDS);
const reps = Number(args.find((a) => /^\d+$/.test(a)) || 5);
const srv = await startServer();
srv.route('/host.html', { body: HOST });
srv.route('/frame.html', { headers: { 'content-security-policy': 'sandbox allow-scripts; frame-ancestors \'self\'' }, body: FRAME });
srv.route('/frame-plain.html', { body: FRAME }); // the same document, not sandboxed: same-origin with the host (control)
for (const build of builds.length ? builds : Object.keys(BUILDS)) {
    for (const flagName of Object.keys(FLAGS)) {
        try { await runConfig(build, flagName, reps, srv); } catch (e) { emit('q4.error', { build, flags: flagName, error: String(e).slice(0, 400) }); }
    }
}
await srv.close();
