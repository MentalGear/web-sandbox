// Q4. What the served frame still takes from the host page (the rows the served document would not close), side by side
// with today's srcdoc frame.
//
//   bun docs/research/27_served_document_headerless/q4-inherited.mjs [chromium|firefox|webkit] [part]
//   parts: secure, perms, coi, referrer (default: all four)
//
// secure:   isSecureContext of each document and worker, on a host page at http://localhost:P (potentially trustworthy)
//           and at http://app.insecure.test:P (not), the latter reached through the server acting as a proxy.
// perms:    navigator.permissions.query() for geolocation, notifications, camera, microphone in each document and
//           worker, with the host origin granted geolocation and notifications (context.grantPermissions), and without.
// coi:      a COOP same-origin + COEP require-corp host page, and the header-less served file.
// referrer: document.referrer, baseURI, location.ancestorOrigins, and the Referer of the frame's request, for a host
//           page at /app/secret?token=HOSTSECRET#frag, with and without referrerpolicy="no-referrer" on the iframe.
// The served file is header-less and carries the M-open <meta> of Q1; the host page has no policy of its own here.
import { ENGINES, emit, emitRun, engineArgs, sleep } from './lib.mjs';
import { HTML, startServer } from './server.mjs';
import { SVG, TEXT, hostPage, probeDocument, servedFile } from './probe-doc.mjs';

const PERMS = ['geolocation', 'notifications', 'camera', 'microphone'];
const args = process.argv.slice(2);
const parts = args.filter((a) => ['secure', 'perms', 'coi', 'referrer'].includes(a));
const want = (p) => !parts.length || parts.includes(p);

const slim = (d) => ({ kind: d.kind, origin: d.origin, secure: d.secure, coi: d.coi, perms: d.perms, referrer: d.referrer, baseURI: d.baseURI, ancestorOrigins: d.ancestorOrigins,
    worker: d.worker && typeof d.worker === 'object' ? { secure: d.worker.secure, coi: d.worker.coi, perms: d.worker.perms } : d.worker });

async function runEngine(name) {
    const srv = await startServer();
    const L = srv.local, I = srv.ip;
    srv.route('/i.svg', SVG);
    srv.route('/c', TEXT);
    const meta = `default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline'; img-src ${I}; connect-src ${I}; worker-src blob:; base-uri ${I}`;
    let perms;
    let base = true;
    srv.route('/frame.html', () => ({ headers: HTML, body: servedFile({ ip: I, local: L, meta, perms, base }).html }));
    let hostHeaders = HTML;
    for (const p of ['/host.html', '/app/secret']) srv.route(p, () => ({ headers: hostHeaders, body: hostPage() }));
    const today = () => probeDocument({ cfg: { kind: 'srcdoc (today)', ip: I, local: L, perms }, base }).html;

    const run = async (page, part, label, hostUrl, attrs = {}) => {
        await page.goto(hostUrl);
        // a goto that differs only in the fragment is a same-document navigation: drop the previous case's frames
        await page.evaluate(() => window.clearAll());
        srv.reset();
        const host = await page.evaluate(async (ps) => {
            const r = { secure: self.isSecureContext, coi: self.crossOriginIsolated };
            if (ps && navigator.permissions) { r.perms = {}; for (const n of ps) { try { r.perms[n] = (await navigator.permissions.query({ name: n })).state; } catch (e) { r.perms[n] = e.name; } } }
            return r;
        }, perms);
        await page.evaluate(([t, a]) => { window.mk('srcdoc', { sandbox: 'allow-scripts', ...a }, t); window.mk('served', { sandbox: 'allow-scripts', src: '/frame.html', ...a }); }, [today(), attrs]);
        await sleep(3500);
        const st = await page.evaluate(() => ({ results: window.results, loads: window.loads }));
        const fr = srv.requests.find((r) => r.path === '/frame.html');
        emit('q4', { engine: name, part, case: label, host, docs: st.results.filter((m) => m && m.probe).map((m) => slim(m.probe)), frameLoadEvents: st.loads,
            frameRequest: fr ? { referer: fr.referer ?? null, site: fr.site, dest: fr.dest } : 'not requested' });
    };

    const browser = await ENGINES[name].launch({ proxy: { server: I } });
    emitRun('q4', name, browser);

    if (want('secure')) {
        const ctx = await browser.newContext();
        const page = await ctx.newPage();
        await run(page, 'secure', 'host at http://localhost:P (potentially trustworthy)', `${L}/host.html`);
        await run(page, 'secure', 'host at http://app.insecure.test:P (not potentially trustworthy, through the proxy)', `http://app.insecure.test:${srv.port}/host.html`);
        await ctx.close();
    }
    if (want('perms')) {
        perms = PERMS;
        for (const grant of [false, true]) {
            const ctx = await browser.newContext();
            const granted = [];
            if (grant) for (const p of ['geolocation', 'notifications']) { try { await ctx.grantPermissions([p], { origin: L }); granted.push(p); } catch (e) { granted.push(`${p}: ${String(e).split('\n')[0].slice(0, 80)}`); } }
            const page = await ctx.newPage();
            await run(page, 'perms', grant ? `host origin granted ${JSON.stringify(granted)}` : 'no grants (control)', `${L}/host.html`);
            await ctx.close();
        }
        perms = undefined;
    }
    if (want('coi')) {
        const ctx = await browser.newContext();
        const page = await ctx.newPage();
        hostHeaders = { ...HTML, 'cross-origin-opener-policy': 'same-origin', 'cross-origin-embedder-policy': 'require-corp' };
        const failed = [];
        page.on('requestfailed', (r) => failed.push(`${r.url().replace(L, '')} ${r.failure()?.errorText}`));
        await run(page, 'coi', 'COOP same-origin + COEP require-corp host, header-less served file', `${L}/host.html`);
        emit('q4', { engine: name, part: 'coi', case: 'requests that failed', failed });
        hostHeaders = HTML;
        await ctx.close();
    }
    if (want('referrer')) {
        base = false;
        const ctx = await browser.newContext();
        const page = await ctx.newPage();
        await run(page, 'referrer', 'default referrer policy, no <base>', `${L}/app/secret?token=HOSTSECRET#frag`);
        await run(page, 'referrer', 'iframe referrerpolicy="no-referrer", no <base>', `${L}/app/secret?token=HOSTSECRET#frag`, { referrerpolicy: 'no-referrer' });
        await ctx.close();
        base = true;
    }
    await browser.close();
    await srv.close();
}

for (const name of engineArgs(args)) {
    try { await runEngine(name); } catch (e) { emit('q4.error', { engine: name, error: String(e).slice(0, 400) }); }
}
