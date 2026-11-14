// Q5. Hosting facts: header sets of static hosts, file://, and offline (Service Worker and HTTP cache).
//
//   bun docs/research/27_served_document_headerless/q5-hosting.mjs [chromium|firefox|webkit] [part]
//   parts: headers, file, cache, sw (default: all four)
//
// headers: the served file (Q1's probe with the M-open <meta>) sent with each header set of HEADER_SETS; does the topology
//          run (frame, srcdoc child, blob: worker), and does the <meta> bind (its canary refused)?
// file:    the host page and the served file as files in a temporary directory, the host opened at file:///.../host.html;
//          today's srcdoc frame, the served frame (sandbox="allow-scripts", src="frame.html") and a non-sandboxed
//          file frame (the control).
// cache:   the served file with Cache-Control: max-age=3600 and an ETag. In one host page: a sandboxed frame, removed,
//          a second one (is the request made again?), then the server stops answering (the socket is destroyed) and
//          a third one (does the HTTP cache alone serve it?). Control: the same steps with a non-sandboxed frame.
// sw:      the host page registers a cache-first Service Worker that precaches the host page and the served file and
//          reports each fetch event. A sandboxed frame is made (does the SW see its navigation?); then the server
//          stops, the host page is loaded again (served by the SW?) and a sandboxed frame is made (who serves it?).
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ENGINES, emit, emitRun, engineArgs, sleep } from './lib.mjs';
import { HTML, startServer } from './server.mjs';
import { SVG, TEXT, hostPage, probeDocument, servedFile } from './probe-doc.mjs';

const args = process.argv.slice(2);
const parts = args.filter((a) => ['headers', 'file', 'cache', 'sw'].includes(a));
const want = (p) => !parts.length || parts.includes(p);

const HEADER_SETS = {
    'Content-Type only': {},
    'typical static host (no CSP)': { 'cache-control': 'max-age=600', etag: '"5f3a-1"', 'last-modified': 'Fri, 13 Nov 2026 10:00:00 GMT', 'access-control-allow-origin': '*', vary: 'Accept-Encoding', server: 'static', 'accept-ranges': 'bytes' },
    'typical static host + X-Content-Type-Options: nosniff': { 'cache-control': 'max-age=600', etag: '"5f3a-1"', 'x-content-type-options': 'nosniff' },
    'X-Frame-Options: SAMEORIGIN': { 'x-frame-options': 'SAMEORIGIN' },
    'X-Frame-Options: DENY': { 'x-frame-options': 'DENY' },
    'Content-Type text/plain (a host that does not know .html)': { 'content-type': 'text/plain' },
};

// A small document for the cache and SW parts: it says who it is and which copy it is (the server stamps each response).
const tiny = (stamp) => `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'"><meta charset="utf-8"></head><body><script>top.postMessage({ tiny: { origin: String(self.origin), stamp: ${JSON.stringify(stamp)} } }, '*');</script></body></html>`;

const SW = `const C = 'r27';
const report = async (o) => { for (const c of await self.clients.matchAll({ includeUncontrolled: true })) c.postMessage({ sw: o }); };
self.addEventListener('install', (e) => e.waitUntil(caches.open(C).then((c) => c.addAll(['/sw-host.html', '/frame.html'])).then(() => self.skipWaiting())));
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  report({ path: u.pathname, mode: e.request.mode, dest: e.request.destination });
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then((r) => r || fetch(e.request)));
});`;

async function runEngine(name) {
    const srv = await startServer();
    const L = srv.local, I = srv.ip;
    srv.route('/i.svg', SVG);
    srv.route('/c', TEXT);
    const meta = `default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline'; img-src ${I}; connect-src ${I}; worker-src blob:; base-uri ${I}`;
    const browser = await ENGINES[name].launch();
    emitRun('q5', name, browser);
    const slim = (d) => ({ kind: d.kind, origin: d.origin, url: d.url, fetch: d.act?.fetch, canary: d.act?.fetchCanary, worker: d.worker && typeof d.worker === 'object' ? { fetch: d.worker.fetch, canary: d.worker.fetchCanary } : d.worker });

    if (want('headers')) {
        let extra = {};
        srv.route('/frame.html', () => ({ headers: { ...HTML, ...extra }, body: servedFile({ ip: I, local: L, meta }).html }));
        srv.route('/host.html', { headers: HTML, body: hostPage() });
        const ctx = await browser.newContext();
        const page = await ctx.newPage();
        let k = 0;
        for (const [label, h] of Object.entries(HEADER_SETS)) {
            extra = h;
            await page.goto(`${L}/host.html`);
            srv.reset();
            // a URL of its own per case: a header set with Cache-Control would otherwise answer the next case from the cache
            await page.evaluate((u) => window.mk('served', { sandbox: 'allow-scripts', src: u }), `/frame.html?case=${++k}`);
            await sleep(3000);
            const st = await page.evaluate(() => ({ results: window.results, loads: window.loads }));
            emit('q5', { engine: name, part: 'headers', case: label, docs: st.results.filter((m) => m && m.probe).map((m) => slim(m.probe)), frameLoadEvents: st.loads });
        }
        await ctx.close();
    }

    if (want('file')) {
        const dir = mkdtempSync(path.join(tmpdir(), 'r27-file-'));
        writeFileSync(path.join(dir, 'frame.html'), servedFile({ ip: I, local: L, meta }).html);
        writeFileSync(path.join(dir, 'host.html'), hostPage());
        const today = probeDocument({ cfg: { kind: 'srcdoc (today)', ip: I, local: L } }).html;
        const ctx = await browser.newContext();
        const page = await ctx.newPage();
        const errors = [];
        page.on('console', (m) => { if (m.type() === 'error' || /file|frame|denied|refused|blocked/i.test(m.text())) errors.push(m.text().slice(0, 200)); });
        await page.goto(pathToFileURL(path.join(dir, 'host.html')).href);
        const host = await page.evaluate(() => ({ origin: String(self.origin), secure: self.isSecureContext }));
        await page.evaluate((t) => {
            window.mk('srcdoc', { sandbox: 'allow-scripts' }, t);
            window.mk('served', { sandbox: 'allow-scripts', src: 'frame.html' });
            window.mk('plain file frame (control)', { src: 'frame.html' });
        }, today);
        await sleep(4000);
        const st = await page.evaluate(() => ({ results: window.results, loads: window.loads }));
        emit('q5', { engine: name, part: 'file', case: 'host page at file://', host, docs: st.results.filter((m) => m && m.probe).map((m) => slim(m.probe)), frameLoadEvents: st.loads, frameUrls: page.frames().map((f) => f.url().slice(0, 60)), console: [...new Set(errors)].slice(0, 12) });
        await ctx.close();
        rmSync(dir, { recursive: true, force: true });
    }

    if (want('cache')) {
        let n = 0;
        const cached = () => ({ headers: { ...HTML, 'cache-control': 'max-age=3600', etag: '"r27"' }, body: tiny(`copy ${++n}`) });
        srv.route('/frame.html', cached);
        srv.route('/frame-plain.html', cached);
        srv.route('/host.html', { headers: HTML, body: hostPage() });
        for (const [label, file, attrs] of [['sandboxed frame', '/frame.html', { sandbox: 'allow-scripts' }], ['non-sandboxed frame (control)', '/frame-plain.html', {}]]) {
            const ctx = await browser.newContext();
            const page = await ctx.newPage();
            srv.down = false;
            await page.goto(`${L}/host.html`);
            srv.reset();
            const steps = [];
            for (const step of ['first', 'second (server up)', 'third (server down)']) {
                if (step.includes('down')) srv.down = true;
                const before = srv.requests.filter((r) => r.path === file).length;
                await page.evaluate(([f, a]) => { window.clearAll(); window.mk('f', { ...a, src: f }); }, [file, attrs]);
                await sleep(1500);
                const st = await page.evaluate(() => ({ results: window.results, loads: window.loads }));
                const reqs = srv.requests.filter((r) => r.path === file);
                steps.push({ step, ran: st.results.map((m) => m.tiny).filter(Boolean), loadEvent: st.loads.length > 0, requestsMade: reqs.length - before, lastRequestHeaders: reqs.length > before ? { cacheControl: reqs.at(-1).cacheControl ?? null, ifNoneMatch: reqs.at(-1).ifNoneMatch ?? null } : null });
            }
            srv.down = false;
            emit('q5', { engine: name, part: 'cache', case: label, steps });
            await ctx.close();
        }
    }

    if (want('sw')) {
        let n = 0;
        srv.route('/frame.html', () => ({ headers: HTML, body: tiny(`network copy ${++n}`) }));
        srv.route('/sw.js', { headers: { 'content-type': 'text/javascript' }, body: SW });
        srv.route('/sw-host.html', { headers: HTML, body: hostPage().replace('</script>', `
window.sw = []; navigator.serviceWorker.addEventListener('message', (e) => window.sw.push(e.data.sw));
window.ready = navigator.serviceWorker.register('/sw.js').then(() => navigator.serviceWorker.ready).then(() => new Promise((r) => { if (navigator.serviceWorker.controller) r(); else navigator.serviceWorker.addEventListener('controllerchange', () => r()); setTimeout(r, 3000); })).then(() => !!navigator.serviceWorker.controller);
</script>`) });
        const ctx = await browser.newContext();
        const page = await ctx.newPage();
        srv.down = false;
        await page.goto(`${L}/sw-host.html`);
        const controlled = await page.evaluate(() => window.ready);
        const step = async (label) => {
            srv.reset();
            await page.evaluate(() => { window.clearAll(); window.sw.length = 0; window.mk('f', { sandbox: 'allow-scripts', src: '/frame.html' }); });
            await sleep(1800);
            const st = await page.evaluate(() => ({ results: window.results, loads: window.loads, sw: window.sw, controlled: !!navigator.serviceWorker.controller }));
            return { step: label, controlled: st.controlled, ran: st.results.map((m) => m.tiny).filter(Boolean), loadEvent: st.loads.length > 0, swFetchEvents: st.sw, networkRequests: srv.requests.filter((r) => r.path === '/frame.html').length };
        };
        const steps = [await step('server up, page that registered')];
        // the positive control: the host page's own fetch of the same URL reaches the SW
        const ctrl = await page.evaluate(async () => { window.sw.length = 0; await fetch('/frame.html?control'); await new Promise((r) => setTimeout(r, 300)); return window.sw.slice(); });
        srv.down = true;
        let reload = 'ok';
        try { await page.goto(`${L}/sw-host.html`, { timeout: 8000 }); } catch (e) { reload = `failed: ${String(e).split('\n')[0].slice(0, 120)}`; }
        if (reload === 'ok') {
            await page.evaluate(() => window.ready).catch(() => null);
            steps.push(await step('server down, host page loaded again'));
        }
        srv.down = false;
        emit('q5', { engine: name, part: 'sw', controlledAfterRegister: controlled, hostFetchControl: ctrl, reloadWhileDown: reload, steps });
        await ctx.close();
    }
    await browser.close();
    await srv.close();
}

for (const name of engineArgs(args)) {
    try { await runEngine(name); } catch (e) { emit('q5.error', { engine: name, error: String(e).slice(0, 400) }); }
}
