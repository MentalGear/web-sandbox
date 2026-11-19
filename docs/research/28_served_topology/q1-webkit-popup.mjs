// Q1, a triage: on WebKit the case "popup opened from a cross-site sandboxed frame" ended with the browser context closed
// in every run. Which step closes it? Each step runs in a browser of its own, so one closing does not hide the next.
//
//   bun docs/research/28_served_topology/q1-webkit-popup.mjs [webkit|chromium|firefox]
//
// Steps, each a popup opened by window.open() from a cross-site frame sandbox="allow-scripts allow-popups":
//   plain        a page with one inline script that sets a global (no worker, no frame)
//   F, no init   the served file of q1 (its checks run in F), and no message posted to it
//   F, init      the same, then the opener posts it the worker source (F creates C, W_F; C creates W_C), as q1 does
//   blob worker  a page whose script starts a blob: worker
//   srcdoc child a page whose script adds a sandboxed srcdoc iframe
// Then `F, init` again after q1's set-up, one part at a time: the file origin granted geolocation; a tab on the file
// origin that set cookies, storage, a database and a cache (no Service Worker); the same tab registering a Service
// Worker too (q1's whole seed).
// Each records whether the popup's global could be read 3 s later and whether the browser is still connected.
import { ENGINES, emit, emitRun, esc, sleep } from './lib.mjs';
import { HTML, startServer } from './server.mjs';
import { SANDBOXED_OPENER, SEED, SW, WORKER_SRC, servedFile } from './topology.mjs';

const PAGES = {
    plain: '<script>window.R = { started: true };</script>',
    'blob worker': `<script>window.R = { started: true }; const w = new Worker(URL.createObjectURL(new Blob(['postMessage(String(self.origin))'], { type: 'text/javascript' }))); w.onmessage = (m) => { R.worker = m.data; };</script>`,
    'srcdoc child': `<script>window.R = { started: true }; const c = document.createElement('iframe'); c.setAttribute('sandbox', 'allow-scripts'); c.srcdoc = '<p>child</p>'; document.body.append(c); R.child = 'added';</script>`,
};

async function step(name, label) {
    const srv = await startServer();
    const L = srv.local, I = srv.ip;
    srv.route('/sbopener', { headers: HTML, body: SANDBOXED_OPENER });
    srv.route('/F.html', { headers: HTML, body: servedFile({ L, tag: 'tag=0' }).html });
    srv.route('/seed.html', { headers: HTML, body: SEED });
    srv.route('/sw.js', SW);
    for (const [k, v] of Object.entries(PAGES)) srv.route(`/${encodeURIComponent(k)}.html`, { headers: HTML, body: `<!doctype html><html><head><meta charset="utf-8"></head><body>${v}</body></html>` });
    const browser = await ENGINES[name].launch();
    if (label === 'plain') emitRun('q1w', name, browser);
    const ctx = await browser.newContext();
    const out = { engine: name, step: label };
    if (label.includes('grant')) await ctx.grantPermissions(['geolocation'], { origin: L }).catch((e) => { out.grant = String(e).slice(0, 80); });
    if (label.includes('seed')) {
        const seedPage = await ctx.newPage();
        await seedPage.goto(`${L}/seed.html`);
        if (label.includes('Service Worker')) await seedPage.evaluate(() => window.seed());
        else await seedPage.evaluate(() => { const r = navigator.serviceWorker.register; navigator.serviceWorker.register = () => Promise.resolve(); return window.seed().finally(() => { navigator.serviceWorker.register = r; }); });
    }
    const page = await ctx.newPage();
    try {
        await page.goto(`${I}/sbopener`);
        await sleep(300);
        const sb = page.frames().find((f) => f !== page.mainFrame());
        const target = label.startsWith('F') ? `${L}/F.html` : `${L}/${encodeURIComponent(label)}.html`;
        const [pop] = await Promise.all([ctx.waitForEvent('page'), sb.evaluate((u) => window.go(u), target)]);
        await pop.waitForLoadState().catch(() => {});
        if (label.startsWith('F, init')) await sb.evaluate((m) => window.w.postMessage(m, '*'), { init: WORKER_SRC });
        await sleep(3000);
        out.global = await pop.evaluate(() => JSON.stringify(window.R).slice(0, 200)).catch((e) => `evaluate failed: ${String(e).slice(0, 100)}`);
    } catch (e) { out.error = String(e).slice(0, 200); }
    out.connected = browser.isConnected();
    out.pages = browser.isConnected() ? ctx.pages().length : 'n/a';
    emit('q1w', out);
    await browser.close().catch(() => {});
}

for (const name of process.argv.slice(2).filter((a) => a in ENGINES)) {
    for (const label of ['plain', 'blob worker', 'srcdoc child', 'F, no init', 'F, init', 'F, init, grant', 'F, init, seed tab', 'F, init, seed tab with Service Worker', 'F, init, grant, seed tab with Service Worker']) {
        try { await step(name, label); } catch (e) { emit('q1w.error', { engine: name, step: label, error: String(e).slice(0, 300) }); }
    }
}
process.exit(0);
