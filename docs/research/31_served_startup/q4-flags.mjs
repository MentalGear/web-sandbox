// Q4a and Q4c. The sandbox flags with F framed as the element frames it (03, "The shape").
//
//   bun docs/research/31_served_startup/q4-flags.mjs <engine>
//
// (a) A guest form in C: after the start-up, C adds a form (an input and a submit button) and counts `submit` (it calls
//     preventDefault). Real input: a mouse click on the button, then Enter typed in the input. F framed
//     sandbox="allow-scripts allow-forms" (the design) and sandbox="allow-scripts" (the negative control).
// (c) A hostile page (another site) frames F with more flags than the element gives: allow-popups, allow-top-navigation,
//     allow-modals, allow-downloads, allow-popups-to-escape-sandbox, all of them, and allow-same-origin. After a real click
//     in C, C tries a popup, an alert, a download and a top navigation and reports what it got; the page records dialogs,
//     popups, downloads and its own URL. Positive control: a file whose C attribute itself carries those flags.
import { ENGINES, emit, emitRun, sleep } from '../28_served_topology/lib.mjs';
import { HTML, startServer } from './server.mjs';
import { hostPage, servedFile } from './fixture.mjs';

const BASE = 'allow-scripts allow-forms';
const MORE = ['allow-popups', 'allow-top-navigation', 'allow-modals', 'allow-downloads', 'allow-popups-to-escape-sandbox'];

const cFrameOf = (page) => page.frames().find((f) => f.parentFrame() && f.parentFrame() !== page.mainFrame() && f.url() === 'about:srcdoc');

async function runEngine(name) {
    const srv = await startServer();
    const F = servedFile();
    const RICH = servedFile({ cAttr: `allow-scripts allow-forms allow-orientation-lock ${MORE.join(' ')}` });
    srv.route('/F.html', { headers: HTML, body: F.html });
    srv.route('/rich.html', { headers: HTML, body: RICH.html });
    srv.route('/host.html', { headers: HTML, body: hostPage(F.cHash) });
    const browser = await ENGINES[name].launch();
    emitRun('q4', name, browser);
    const ctx = await browser.newContext({ acceptDownloads: true });

    // (a) forms
    for (const attrs of [BASE, 'allow-scripts']) {
        const page = await ctx.newPage();
        await page.goto(`${srv.local}/host.html`);
        const r = await page.evaluate((a) => window.start('/F.html', { attrs: a, keep: true }), attrs);
        await page.evaluate(() => window.cmd('form'));
        const c = cFrameOf(page);
        let clicked = 'no C frame', typed = '';
        if (c) {
            clicked = await c.click('#go', { timeout: 3000 }).then(() => 'clicked', (e) => 'click failed: ' + String(e).slice(0, 80));
            await sleep(200);
            typed = await c.click('#q', { timeout: 3000 }).then(() => page.keyboard.type('abc')).then(() => page.keyboard.press('Enter')).then(() => 'typed, Enter', (e) => 'failed: ' + String(e).slice(0, 80));
            await sleep(300);
        }
        const acks = await page.evaluate(() => window.last.acks.filter((a) => a && 'submit' in a));
        const violations = await (c ? c.evaluate(() => 0).catch(() => null) : null);
        emit('q4.forms', { engine: name, fAttrs: attrs, start: r.end, clicked, typed, submits: acks.length, trusted: acks.map((a) => a.trusted), cUrl: c && c.url(), violations });
        await page.close();
    }

    // (c) a hostile page with more flags (another site: 127.0.0.1 frames the file at localhost)
    const runs = [
        ...MORE.map((f) => [`F framed ${BASE} ${f}`, '/F.html', `${BASE} ${f}`, F.cHash]),
        [`F framed ${BASE} ${MORE.join(' ')}`, '/F.html', `${BASE} ${MORE.join(' ')}`, F.cHash],
        [`F framed ${BASE} allow-same-origin`, '/F.html', `${BASE} allow-same-origin`, F.cHash],
        [`F framed ${BASE} (the element's own flags)`, '/F.html', BASE, F.cHash],
        [`positive control: C's own attribute carries ${MORE.join(' ')}, F framed with them`, '/rich.html', `${BASE} ${MORE.join(' ')}`, RICH.cHash],
    ];
    for (const [label, path, attrs, hash] of runs) {
        const page = await ctx.newPage();
        const dialogs = [], popups = [], downloads = [];
        page.on('dialog', (d) => { dialogs.push(d.message()); d.dismiss().catch(() => {}); });
        page.on('download', (d) => downloads.push(d.suggestedFilename()));
        const onPage = (p) => popups.push(p.url());
        ctx.on('page', onPage);
        await page.goto(`${srv.ip}/host.html`);
        const r = await page.evaluate(([u, a, h]) => window.start(`${u}`, { attrs: a, expectHash: h, keep: true, timeout: 4000 }), [`${srv.local}${path}`, attrs, hash]);
        let flags = null;
        if (r.decision === 'send') {
            const c = cFrameOf(page);
            const click = c ? await c.click('#still', { timeout: 3000 }).then(() => 'clicked', (e) => 'failed ' + String(e).slice(0, 60)) : 'no C';
            const got = await page.evaluate(() => window.cmd('flags', 1500)).catch((e) => [{ error: String(e).slice(0, 100) }]);
            flags = { click, result: got.find((m) => m && m.flags)?.flags ?? got };
        }
        await sleep(500);
        ctx.off('page', onPage);
        emit('q4.flags', { engine: name, case: label, fAttrs: attrs, start: r.end, decision: r.decision, flags, dialogs, popups, downloads, topUrlAfter: page.isClosed() ? 'closed' : page.url() });
        for (const p of ctx.pages()) if (p !== page) await p.close().catch(() => {});
        await page.close().catch(() => {});
    }
    await browser.close();
}

for (const name of process.argv.slice(2).filter((a) => a in ENGINES)) {
    try { await runEngine(name); } catch (e) { emit('q4.error', { engine: name, error: String(e).slice(0, 400) }); }
}
process.exit(0);
