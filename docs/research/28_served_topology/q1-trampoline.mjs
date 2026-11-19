// Q1 (and Q4a). The trampoline: does the view C, and the worker W, have an opaque origin whatever way the served file F
// was opened, because F itself sets the `sandbox` attribute on C? And does the worker keep it when F creates it (W_F)
// instead of C (W_C)?
//
//   bun docs/research/28_served_topology/q1-trampoline.mjs <engine> [file-at-ip] [static|guarded]
//
// The twelve ways of opening F of research 27 Q2, each with F's own policy (connect-src 'none') and with the control
// policy (connect-src the file's origin, so requests leave and the server sees which cookies they carry). In every case
// the embedder (or the opener) posts F a worker source; F creates C and W_F, C creates W_C, and each of F, C, W_C, W_F
// runs the checks of topology.mjs. Before the cases, a tab on the file's origin (and one on the other site) sets cookies,
// localStorage, an IndexedDB database, a cache and a Service Worker registration, is granted geolocation, and listens
// on a BroadcastChannel.
//
// `file-at-ip` serves F from http://127.0.0.1:P instead of http://localhost:P (Q4a: the file on another site than the
// host page that embeds it legitimately, which is then the cross-site sandboxed case).
//
// `static`: F is a static document that runs no script, with C in its markup (topology.mjs, staticFile); the poster
// posts to C (`frames[0]` of F) instead of F, and there is no W_F. `guarded`: the same with research 27's guard as F's
// only script, placed before C's markup, which stops the document (window.stop()) unless its origin is opaque and it is
// framed; the case then records whether C exists.
import { ENGINES, emit, emitRun, sleep } from './lib.mjs';
import { HTML, startServer } from './server.mjs';
import { EMBED, OPENER, SANDBOXED_OPENER, SEED, SW, WORKER_SRC, servedFile, staticFile } from './topology.mjs';

const SHOW = 'Text chosen by whoever posted the init message';

async function runEngine(name, fileAtIp, topology, onlyConnect, part) {
    const isStatic = topology !== 'script';
    const srv = await startServer();
    const srv2 = await startServer();
    const L = srv.local, I = srv.ip;
    const FO = fileAtIp ? I : L; // the file's origin
    const SS = fileAtIp ? srv2.ip : srv2.local; // same site, another origin
    const XS = fileAtIp ? L : I; // another site
    for (const s of [srv, srv2]) {
        s.route('/F.html', (req, url) => {
            const tag = url.searchParams.get('tag');
            const connect = url.searchParams.get('connect') === 'open' ? FO : "'none'";
            if (isStatic) return { headers: HTML, body: staticFile(connect, topology === 'guarded').html };
            return { headers: HTML, body: servedFile({ L: FO, tag: `tag=${tag}` }, connect).html };
        });
        s.route('/c', { headers: { 'content-type': 'text/plain' }, body: 'ok' });
        s.route('/seed.html', { headers: HTML, body: SEED });
        s.route('/sw.js', SW);
        s.route('/embed', (req, url) => ({ headers: HTML, body: EMBED(url.searchParams.get('target'), url.searchParams.get('attrs') || '') }));
        s.route('/opener', { headers: HTML, body: OPENER });
        s.route('/sbopener', { headers: HTML, body: SANDBOXED_OPENER });
    }

    const browser = await ENGINES[name].launch();
    emitRun('q1', name, browser);
    emit('q1.topology', { engine: name, topology });
    const ctx = await browser.newContext();
    for (const origin of [L, I]) { try { await ctx.grantPermissions(['geolocation'], { origin }); } catch (e) { emit('q1.note', { engine: name, grant: String(e).slice(0, 120) }); } }
    const seeds = {};
    for (const [label, origin] of [['file origin', FO], ['other site', XS]]) {
        const p = await ctx.newPage();
        await p.goto(`${origin}/seed.html`);
        seeds[label] = { page: p, seeded: await p.evaluate(() => window.seed()) };
    }
    emit('q1.seed', { engine: name, fileOrigin: FO, seeded: Object.fromEntries(Object.entries(seeds).map(([k, v]) => [k, v.seeded])) });

    let page = await ctx.newPage();
    // what the poster sends: the worker source, a text for C to show, and (read by the static C only; F has its own) the config
    const initFor = (frame) => ({ init: WORKER_SRC, show: SHOW, cfg: { L: FO, tag: `tag=${new URL(frame.url()).searchParams.get('tag')}` } });
    // the window to post to: F, or C in the static topologies (F's frames[0])
    const into = isStatic ? '.frames[0]' : '';
    const complete = (r) => r && r.C && r.WC && (isStatic || (r.F && r.WF));
    const readR = async (frame) => {
        for (let i = 0; i < 150; i++) { // up to 30 s: each check answers within 2 s
            const r = await frame.evaluate(() => window.R).catch(() => null);
            if (complete(r)) return r;
            if (!r && i >= 10) break; // F's script never ran
            await sleep(200);
        }
        return frame.evaluate(() => window.R).catch((e) => `evaluate failed: ${String(e).slice(0, 120)}`);
    };
    const childText = async (frame) => {
        const c = frame.childFrames()[0];
        return c ? c.evaluate(() => document.body.innerText).catch((e) => `evaluate failed: ${String(e).slice(0, 80)}`) : 'no child frame';
    };
    const findF = (p) => p.frames().find((fr) => fr.url().includes('/F.html'));

    let n = 0;
    // one case's failure is recorded and the run goes on (a case is tried twice before it is recorded as failed)
    const guard = async (label, connect, body) => {
        for (let attempt = 1; attempt <= 2; attempt++) {
            if (page.isClosed()) page = await ctx.newPage(); // WebKit closed it in the sandboxed-popup case (see the README)
            try { await body(); return; } catch (e) { emit('q1.caseError', { engine: name, connect, case: label, attempt, error: String(e).slice(0, 300) }); }
        }
    };
    for (const connect of [onlyConnect]) {
        const target = () => `${FO}/F.html?tag=${++n}&connect=${connect}`;
        const record = async (label, embedder, frame, topPage) => {
            const tag = new URL(frame.url()).searchParams.get('tag');
            let R;
            if (isStatic) {
                const c = frame.childFrames()[0];
                R = c ? await readR(c) : {};
                R = { ...(R && typeof R === 'object' ? R : { C: R }), F: { static: 'runs no script but the guard, if any', guard: await frame.evaluate(() => window.G ?? 'no guard').catch((e) => String(e).slice(0, 60)), childFrame: c ? 'present' : 'absent' } };
            } else R = await readR(frame);
            await sleep(300);
            const requests = srv.requests.concat(srv2.requests).filter((r) => r.path === '/c' && r.query.includes(`tag=${tag}&`))
                .map((r) => ({ q: r.query.replace(/^\?tag=\d+&/, ''), cookie: r.cookie, origin: r.origin, site: r.site }));
            const broadcast = {};
            for (const [k, v] of Object.entries(seeds)) broadcast[k] = (await v.page.evaluate(() => window.bc)).filter((m) => m.tag === `tag=${tag}`).map((m) => m.from);
            emit('q1', { engine: name, topology, fileOrigin: FO === L ? 'L' : 'I', connect, case: label, embedder, topUrl: topPage.url(), R, requests, broadcast, childText: await childText(frame) });
        };

        // 1. top-level navigation; nobody holds a handle, so F posts to itself (who posts does not change the realms)
        if (part === 'main') await guard('top-level navigation', connect, async () => {
            // 'commit': the guarded file stops its own load (window.stop()), so it never fires `load`
            await page.goto(target(), { waitUntil: 'commit' });
            await sleep(800);
            await page.evaluate(([m, into]) => (into ? frames[0] : window).postMessage(m, '*'), [initFor(page.mainFrame()), into]).catch(() => {});
            await record('top-level navigation', 'none', page.mainFrame(), page);
        });

        // 2. a popup opened by a cross-site page, which posts to it
        if (part === 'main') await guard('popup opened by a cross-site page', connect, async () => {
            await page.goto(`${XS}/opener`);
            const t = target();
            const [pop] = await Promise.all([ctx.waitForEvent('page'), page.evaluate((u) => { window.w = window.open(u); }, t)]);
            await pop.waitForLoadState('domcontentloaded', { timeout: 3000 }).catch(() => {});
            await sleep(800);
            await page.evaluate(([m, into]) => (into ? window.w.frames[0] : window.w).postMessage(m, '*'), [initFor(pop.mainFrame()), into]).catch(() => {});
            await record('popup opened by a cross-site page', 'XS (opener)', pop.mainFrame(), pop);
            await pop.close();
        });

        // 3.-11. framed
        const framed = [
            ['framed by the file origin, sandbox="allow-scripts" (the legitimate case for a same-origin file)', FO, 'sandbox="allow-scripts"'],
            ['framed by the file origin, sandbox="allow-scripts", referrerpolicy="no-referrer"', FO, 'sandbox="allow-scripts" referrerpolicy="no-referrer"'],
            ['framed by the file origin, no sandbox attribute', FO, ''],
            ['framed by the file origin, sandbox="allow-scripts allow-same-origin"', FO, 'sandbox="allow-scripts allow-same-origin"'],
            ['framed same-site cross-origin, no sandbox attribute', SS, ''],
            ['framed cross-site, no sandbox attribute', XS, ''],
            ['framed cross-site, sandbox="allow-scripts allow-same-origin"', XS, 'sandbox="allow-scripts allow-same-origin"'],
            ['framed cross-site, sandbox="allow-scripts"', XS, 'sandbox="allow-scripts"'],
            ['framed cross-site, sandbox="allow-scripts", referrerpolicy="no-referrer"', XS, 'sandbox="allow-scripts" referrerpolicy="no-referrer"'],
        ];
        for (const [label, origin, attrs] of part === 'main' ? framed : []) {
            await guard(label, connect, async () => {
                // 'commit': on WebKit a subframe that stops its own load (the guarded file) keeps the embedder's `load` from firing
                await page.goto(`${origin}/embed?target=${encodeURIComponent(target())}&attrs=${encodeURIComponent(attrs)}`, { waitUntil: 'commit' });
                await sleep(1200);
                const f = findF(page);
                if (!f) throw new Error('no frame with the file');
                await page.evaluate(([m, into]) => (into ? frames[0].frames[0] : frames[0]).postMessage(m, '*'), [initFor(f), into]).catch(() => {});
                await record(label, origin === FO ? 'FO' : origin === SS ? 'SS' : 'XS', f, page);
            });
        }

        // 12. a popup opened from a cross-site page's frame sandbox="allow-scripts allow-popups" (the popup inherits the sandbox)
        const sbLabel = 'popup opened from a cross-site sandboxed frame (allow-scripts allow-popups)';
        if (part === 'sbpopup') await guard(sbLabel, connect, async () => {
            await page.goto(`${XS}/sbopener`);
            await sleep(300);
            const sb = page.frames().find((f) => f !== page.mainFrame());
            const t = target();
            const [pop] = await Promise.all([ctx.waitForEvent('page'), sb.evaluate((u) => window.go(u), t)]);
            await pop.waitForLoadState().catch(() => {});
            await sleep(500);
            await sb.evaluate(([m, into]) => (into ? window.w.frames[0] : window.w).postMessage(m, '*'), [initFor(pop.mainFrame()), into]).catch(() => {});
            await record(sbLabel, 'XS (sandboxed opener)', pop.mainFrame(), pop);
            await pop.close();
        });
    }
    await browser.close().catch(() => {});
}

const args = process.argv.slice(2);
const fileAtIp = args.includes('file-at-ip');
const topology = args.includes('static') ? 'static' : args.includes('guarded') ? 'guarded' : 'script';
// Each connect policy and the sandboxed-popup case run in a browser of their own: WebKit closed the browser in that case
// (the README), which would otherwise end every case after it.
for (const name of args.filter((a) => a in ENGINES)) {
    for (const part of ['main', 'sbpopup']) {
        for (const connect of ['none', 'open']) {
            try { await runEngine(name, fileAtIp, topology, connect, part); } catch (e) { emit('q1.error', { engine: name, connect, part, error: String(e).slice(0, 400) }); }
        }
    }
}
process.exit(0); // the servers' keep-alive sockets must not hold the run open after an error
